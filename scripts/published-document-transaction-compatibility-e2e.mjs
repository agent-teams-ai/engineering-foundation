import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDocumentEnvelopeV3 } from "../tests/fixtures/document-authoring-envelope-v3.mjs";
import { installPublishedFoundation } from "./published-foundation-install.mjs";
import { publishedFoundationIntegrity } from "./published-foundation-imports.ts";
import { executePublishedFoundationOperation } from "./published-foundation-operations.ts";

const publishedVersion = "0.14.0";
const expectedIntegrity = publishedFoundationIntegrity(publishedVersion);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function assertPublishedMutationBlocked({
  operation,
  packageRoot,
  consumerRoot,
  targetRoot,
}) {
  const observation = await executePublishedFoundationOperation({
    packageRoot,
    version: publishedVersion,
    consumerRoot,
    operation,
    ...(targetRoot === undefined ? {} : { targetRoot }),
  });
  if (
    observation.outcome !== "threw" ||
    !(
      (["SCAFFOLD_RECOVERY_REQUIRED", "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED"].includes(
        observation.error.code,
      ) &&
        observation.error.message ===
          "Foundation transaction schema version 3 is unsupported and was preserved.") ||
      (observation.error.code === "LOCAL_STATE_INVALID" &&
        /^(?:Foundation operation lock path must be a real local directory|Another foundation operation is active or its lock is not safely recoverable)\.$/u.test(
          observation.error.message,
        ))
    )
  ) {
    throw new Error(
      `Published Foundation ${publishedVersion} operation ${operation} did not fail closed.`,
      { cause: observation },
    );
  }
}

export async function verifyPublishedDocumentTransactionCompatibility({
  installPackage,
  temporaryRoot,
}) {
  const consumerRoot = join(temporaryRoot, "published-0.14.0-document-v3");
  const installed = await installPublishedFoundation({
    expectedIntegrity,
    installPackage,
    root: consumerRoot,
    version: publishedVersion,
  });
  const contractFixture = JSON.parse(
    await readFile(
      join(repositoryRoot, "tests", "fixtures", "document-authoring-contracts", "valid-v1.json"),
      "utf8",
    ),
  );
  const transactionPath = join(consumerRoot, ".agent-teams-local", "scaffolding-transaction.json");
  await mkdir(dirname(transactionPath), { recursive: true });
  const transactionBytes = Buffer.from(
    `${JSON.stringify(createDocumentEnvelopeV3(contractFixture), null, 2)}\n`,
    "utf8",
  );
  await writeFile(transactionPath, transactionBytes);
  const sentinelPath = join(consumerRoot, "consumer-owned.txt");
  const sentinelBytes = Buffer.from("consumer bytes must remain unchanged\n", "utf8");
  await writeFile(sentinelPath, sentinelBytes);

  const statusObservation = await executePublishedFoundationOperation({
    packageRoot: installed.packageRoot,
    version: publishedVersion,
    consumerRoot,
    operation: "status",
  });
  const status = statusObservation.outcome === "returned" ? statusObservation.value : undefined;
  if (
    status?.mode !== "INVALID" ||
    status.transaction?.state !== "manual-recovery-required" ||
    status.transaction.reason !== "unsupported-schema"
  ) {
    throw new Error(
      `Published Foundation ${publishedVersion} did not report envelope v3 as preserved unsupported evidence.`,
      { cause: statusObservation },
    );
  }

  for (const request of [
    { operation: "recover" },
    { operation: "detach" },
    { operation: "attach", targetRoot: join(temporaryRoot, "unreachable-foundation-target") },
  ]) {
    await assertPublishedMutationBlocked({
      ...request,
      packageRoot: installed.packageRoot,
      consumerRoot,
    });
    if (
      !(await readFile(transactionPath)).equals(transactionBytes) ||
      !(await readFile(sentinelPath)).equals(sentinelBytes)
    ) {
      throw new Error(
        `Published Foundation ${publishedVersion} changed consumer bytes while ${request.operation} was blocked.`,
      );
    }
  }

  process.stdout.write(
    `Published document transaction operation-boundary compatibility PASS: ${publishedVersion} preserves envelope v3 and blocks mutation; integrity ${expectedIntegrity}.\n`,
  );
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDocumentEnvelopeV3 } from "../tests/fixtures/document-authoring-envelope-v3.mjs";
import { captureFailure, runCommand } from "./pack-test-support.mjs";
import { installPublishedFoundation } from "./published-foundation-install.mjs";

const publishedVersion = "0.14.0";
const expectedIntegrity =
  "sha512-4wLDBtGKwLvvd9LuD6g6nuI/BE/qD0IlKATegMqo0ItT1eeT8Lhd0x6lnV6QnHkKWx+sX+H6vsKs/9fNSDhm9Q==";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function assertPublishedMutationBlocked({ args, cliPath, consumerRoot }) {
  const failure = await captureFailure(() =>
    runCommand(process.execPath, [cliPath, ...args], consumerRoot),
  );
  if (
    failure?.code !== 1 ||
    failure.stdout !== "" ||
    !/(?:SCAFFOLD_RECOVERY_REQUIRED|FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED): Foundation transaction schema version 3 is unsupported and was preserved\.|LOCAL_STATE_INVALID: (?:Foundation operation lock path must be a real local directory|Another foundation operation is active or its lock is not safely recoverable)\./u.test(
      failure.stderr,
    )
  ) {
    throw new Error(
      `Published Foundation ${publishedVersion} did not fail closed for ${args[0]}.`,
      { cause: failure },
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
      join(
        repositoryRoot,
        "tests",
        "fixtures",
        "document-authoring-contracts",
        "valid-v1.json",
      ),
      "utf8",
    ),
  );
  const transactionPath = join(
    consumerRoot,
    ".agent-teams-local",
    "scaffolding-transaction.json",
  );
  await mkdir(dirname(transactionPath), { recursive: true });
  const transactionBytes = Buffer.from(
    `${JSON.stringify(createDocumentEnvelopeV3(contractFixture), null, 2)}\n`,
    "utf8",
  );
  await writeFile(transactionPath, transactionBytes);
  const sentinelPath = join(consumerRoot, "consumer-owned.txt");
  const sentinelBytes = Buffer.from("consumer bytes must remain unchanged\n", "utf8");
  await writeFile(sentinelPath, sentinelBytes);

  const statusFailure = await captureFailure(() =>
    runCommand(
      process.execPath,
      [installed.cliPath, "status", "--consumer", consumerRoot, "--json"],
      consumerRoot,
    ),
  );
  const status = JSON.parse(statusFailure?.stdout ?? "null");
  if (
    statusFailure?.code !== 1 ||
    statusFailure.stderr !== "" ||
    status.transaction?.state !== "manual-recovery-required" ||
    status.transaction.reason !== "unsupported-schema"
  ) {
    throw new Error(
      `Published Foundation ${publishedVersion} did not report envelope v3 as preserved unsupported evidence.`,
      { cause: statusFailure },
    );
  }

  for (const args of [
    ["scaffold-recover", "--consumer", consumerRoot, "--json"],
    ["detach", "--consumer", consumerRoot, "--json"],
    [
      "attach",
      join(temporaryRoot, "unreachable-foundation-target"),
      "--consumer",
      consumerRoot,
      "--json",
    ],
  ]) {
    await assertPublishedMutationBlocked({
      args,
      cliPath: installed.cliPath,
      consumerRoot,
    });
    if (
      !(await readFile(transactionPath)).equals(transactionBytes) ||
      !(await readFile(sentinelPath)).equals(sentinelBytes)
    ) {
      throw new Error(
        `Published Foundation ${publishedVersion} changed consumer bytes while ${args[0]} was blocked.`,
      );
    }
  }

  process.stdout.write(
    `Published document transaction compatibility PASS: ${publishedVersion} preserves envelope v3 and blocks mutation; integrity ${expectedIntegrity}.\n`,
  );
}

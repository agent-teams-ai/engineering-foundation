import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalDigest,
  captureFailure,
  runCommand,
} from "./pack-test-support.mjs";
import { installPublishedFoundation } from "./published-foundation-install.mjs";

const version = "0.11.0";
const expectedIntegrity =
  "sha512-L/mWa40ziy3veWzEwp3uH4PTSNInmQb02Na0FeyTk8VoXHNApJon2tegQLOkpbwxEAZCP9aSywCm+1hYbxcUrg==";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageName = "@agent-teams/engineering-foundation";

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pnpmLockSource() {
  const packageKey = `${packageName}@${version}`;
  return [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    `      ${JSON.stringify(packageName)}:`,
    `        specifier: ${JSON.stringify(version)}`,
    `        version: ${JSON.stringify(version)}`,
    "",
    "packages:",
    "",
    `  ${JSON.stringify(packageKey)}:`,
    `    resolution: {integrity: ${JSON.stringify(expectedIntegrity)}}`,
    "",
    "snapshots:",
    "",
    `  ${JSON.stringify(packageKey)}: {}`,
    "",
  ].join("\n");
}

async function prepareConsumer(consumerRoot, installedPackageRoot) {
  await cp(
    dirname(dirname(installedPackageRoot)),
    join(consumerRoot, "node_modules"),
    { recursive: true },
  );
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "old-foundation-transaction-consumer",
        packageManager: "pnpm@11.18.0",
        private: true,
        type: "module",
        devDependencies: { [packageName]: version },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const lockSource = pnpmLockSource();
  await writeFile(join(consumerRoot, "pnpm-lock.yaml"), lockSource, "utf8");
  await mkdir(join(consumerRoot, "node_modules", ".pnpm"), {
    recursive: true,
  });
  await writeFile(
    join(consumerRoot, "node_modules", ".pnpm", "lock.yaml"),
    lockSource,
    "utf8",
  );
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function treeEvidence(root, relativePath = "") {
  const directory = join(root, relativePath);
  const evidence = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted(
    (left, right) => compareStrings(left.name, right.name),
  )) {
    const entryRelativePath = join(relativePath, entry.name);
    const entryPath = join(root, entryRelativePath);
    if (entry.isDirectory()) {
      evidence.push(`d:${entryRelativePath}`);
      evidence.push(...(await treeEvidence(root, entryRelativePath)));
    } else if (entry.isFile()) {
      const bytes = await readFile(entryPath);
      evidence.push(`f:${entryRelativePath}:${bytes.byteLength}:${digestBytes(bytes)}`);
    } else {
      evidence.push(`o:${entryRelativePath}`);
    }
  }
  return evidence;
}

async function mutationEvidence(consumerRoot) {
  const stateRoot = join(consumerRoot, ".agent-teams-local");
  const installedPackageRoot = join(
    consumerRoot,
    "node_modules",
    "@agent-teams",
    "engineering-foundation",
  );
  const installedMetadata = await lstat(installedPackageRoot);
  return JSON.stringify({
    installedIsRealDirectory:
      installedMetadata.isDirectory() && !installedMetadata.isSymbolicLink(),
    installedRealpath: await realpath(installedPackageRoot),
    installedTree: await treeEvidence(installedPackageRoot),
    manifestDigest: digestBytes(await readFile(join(consumerRoot, "package.json"))),
    rootLockDigest: digestBytes(await readFile(join(consumerRoot, "pnpm-lock.yaml"))),
    stateTree: await treeEvidence(stateRoot),
    virtualLockDigest: digestBytes(
      await readFile(join(consumerRoot, "node_modules", ".pnpm", "lock.yaml")),
    ),
  });
}

async function assertOldMutationBlocked({ args, cliPath, consumerRoot, expected }) {
  const failure = await captureFailure(() =>
    runCommand(process.execPath, [cliPath, ...args], consumerRoot),
  );
  if (
    failure?.code !== 1 ||
    failure.stdout !== "" ||
    !/LOCAL_STATE_INVALID: (?:Foundation operation lock path must be a real local directory|Another foundation operation is active or its lock is not safely recoverable)\./u.test(
      failure.stderr,
    )
  ) {
    throw new Error(
      `Published Foundation ${version} did not fail closed for ${args[0]}.`,
      { cause: failure },
    );
  }
  if ((await mutationEvidence(consumerRoot)) !== expected) {
    throw new Error(
      `Published Foundation ${version} mutated consumer state while ${args[0]} was blocked.`,
    );
  }
}

export async function verifyOldFoundationTransactionBarrier({ currentCliPath }) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "foundation-old-version-e2e-"),
  );
  try {
    const installed = await installPublishedFoundation({
      expectedIntegrity,
      root: join(temporaryRoot, "published-package"),
      version,
    });
    const consumerRoot = join(temporaryRoot, "consumer");
    await prepareConsumer(consumerRoot, installed.packageRoot);
    const transactionPath = join(
      consumerRoot,
      ".agent-teams-local",
      "scaffolding-transaction.json",
    );
    await mkdir(join(consumerRoot, ".agent-teams-local"), { recursive: true });
    const documentFixture = JSON.parse(
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
    const journal = {
      ...documentFixture.documentEnvelope.journal,
      plan: documentFixture.plan,
    };
    const envelopeBody = {
      ...documentFixture.documentEnvelope,
      journal,
      payloadDigest: canonicalDigest(journal),
    };
    delete envelopeBody.envelopeDigest;
    const envelope = {
      ...envelopeBody,
      envelopeDigest: canonicalDigest(envelopeBody),
    };
    const transactionBytes = Buffer.from(
      `${JSON.stringify(envelope, null, 2)}\n`,
      "utf8",
    );
    await writeFile(transactionPath, transactionBytes);

    const currentFailure = await captureFailure(() =>
      runCommand(
        process.execPath,
        [
          currentCliPath,
          "scaffold-recover",
          "--consumer",
          consumerRoot,
          "--json",
        ],
        consumerRoot,
      ),
    );
    if (
      currentFailure?.code !== 1 ||
      currentFailure.stdout !== "" ||
      !/SCAFFOLD_RECOVERY_REQUIRED/u.test(currentFailure.stderr)
    ) {
      throw new Error(
        "Current Foundation did not establish the persistent downgrade barrier.",
      );
    }
    const lockPath = join(
      consumerRoot,
      ".agent-teams-local",
      "foundation-operation.lock",
    );
    const lockHandle = await open(lockPath, "r");
    let lockEvidence;
    let lockMetadata;
    try {
      lockMetadata = await lockHandle.stat();
      lockEvidence = JSON.parse(await lockHandle.readFile("utf8"));
    } finally {
      await lockHandle.close();
    }
    if (
      !lockMetadata.isFile() ||
      lockMetadata.isSymbolicLink() ||
      lockEvidence.schemaVersion !== 2 ||
      lockEvidence.kind !== "transaction-barrier"
    ) {
      throw new Error("Current Foundation did not persist a valid downgrade barrier.");
    }
    if (!(await readFile(transactionPath)).equals(transactionBytes)) {
      throw new Error("Current Foundation changed the blocked envelope v2 evidence.");
    }

    const statusFailure = await captureFailure(() =>
      runCommand(
        process.execPath,
        [currentCliPath, "status", "--consumer", consumerRoot, "--json"],
        consumerRoot,
      ),
    );
    const status = JSON.parse(statusFailure?.stdout ?? "null");
    if (
      statusFailure?.code !== 1 ||
      statusFailure.stderr !== "" ||
      status.transaction?.state !== "pending" ||
      status.transaction.recovery?.exactFoundationBuildIdentity !==
        documentFixture.documentEnvelope.foundation.buildIdentity
    ) {
      throw new Error("Current status omitted exact transaction recovery evidence.");
    }

    const beforeOldCommands = await mutationEvidence(consumerRoot);
    await assertOldMutationBlocked({
      args: ["scaffold-recover", "--consumer", consumerRoot, "--json"],
      cliPath: installed.cliPath,
      consumerRoot,
      expected: beforeOldCommands,
    });
    await assertOldMutationBlocked({
      args: [
        "attach",
        join(temporaryRoot, "unreachable-foundation-target"),
        "--consumer",
        consumerRoot,
        "--json",
      ],
      cliPath: installed.cliPath,
      consumerRoot,
      expected: beforeOldCommands,
    });
    await assertOldMutationBlocked({
      args: ["detach", "--consumer", consumerRoot, "--json"],
      cliPath: installed.cliPath,
      consumerRoot,
      expected: beforeOldCommands,
    });
    if (!(await readFile(transactionPath)).equals(transactionBytes)) {
      throw new Error(`Published Foundation ${version} changed envelope v2 evidence.`);
    }
    process.stdout.write(
      `Published downgrade barrier qualification PASS: ${version} recover/attach/detach; integrity ${expectedIntegrity}.\n`,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

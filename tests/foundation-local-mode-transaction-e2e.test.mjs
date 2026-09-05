import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-coordinator.js";
import { FoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-coordinator.js";
import { FoundationTransactionError } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-error.js";
import {
  applyFilesystemScaffold,
  planScaffoldFromFile,
  recoverFilesystemScaffold,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scaffoldFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer",
);

function statePath(root) {
  return join(root, ".agent-teams-local", "foundation-link.json");
}

function backupPath(root) {
  return join(root, ".agent-teams-local", "foundation-registry-backup");
}

function transactionPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function observe(path) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false };
    }
    if (error?.code === "EISDIR" || error?.code === "EPERM") {
      const metadata = await lstat(path);
      return {
        exists: true,
        type: metadata.isDirectory() ? "directory" : "other",
      };
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    return metadata.isFile()
      ? { exists: true, type: "file", bytes: await handle.readFile() }
      : { exists: true, type: metadata.isDirectory() ? "directory" : "other" };
  } finally {
    await handle.close();
  }
}

async function prepareCrashEvidence(root, phase) {
  const backup = backupPath(root);
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, "package.json"), '{"name":"registry-backup"}\n');
  if (phase === "orphan-backup") {
    return;
  }
  await writeJson(statePath(root), {
    schemaVersion: 1,
    phase,
    consumerRoot: root,
    targetPackageRoot: join(root, ".foundation-source"),
    registryBackupPath: backup,
    registryEntryKind: "directory",
    registryPackageRoot: join(
      root,
      "node_modules",
      "@agent-teams",
      "engineering-foundation",
    ),
    packageVersion: "0.12.0",
    gitCommit: "a".repeat(40),
    gitDirty: false,
    attachedAt: "2026-08-12T00:00:00.000Z",
  });
}

function coordinatorWith(status) {
  return new FoundationTransactionCoordinator({
    lock: { async acquire() { return async () => {}; } },
    slot: { async inspect() { return status; } },
  });
}

test("admits detach recovery only for local-mode evidence", async () => {
  const scaffolding = coordinatorWith({
    state: "pending",
    operationKind: "scaffolding",
    format: "legacy-scaffolding-v1",
    foundationVersion: "0.12.0",
    recovery: {
      commandId: "scaffold-recover",
      exactFoundationVersion: "0.12.0",
    },
    diagnostics: [
      { code: "FOUNDATION_TRANSACTION_ACTIVE", message: "pending scaffold" },
    ],
  });
  await assert.rejects(
    scaffolding.acquire({
      requestedMutation: "detach",
      allowRecoveryOf: "local-mode",
    }),
    (error) =>
      error instanceof FoundationTransactionError &&
      error.code === "FOUNDATION_TRANSACTION_ACTIVE",
  );
});

test("blocks every scaffold mutation over incomplete local-mode evidence", async (context) => {
  for (const phase of ["ATTACHING", "DETACHING", "orphan-backup"]) {
    await context.test(phase, async () => {
      const root = await mkdtemp(join(tmpdir(), "foundation-local-mode-crash-"));
      try {
        await cp(scaffoldFixtureRoot, root, { recursive: true });
        const plan = await planScaffoldFromFile({
          consumerRoot: root,
          intentPath: "intents/create-fixture.yaml",
        });
        await prepareCrashEvidence(root, phase);
        const evidencePaths = [
          statePath(root),
          backupPath(root),
          join(backupPath(root), "package.json"),
          transactionPath(root),
          `${transactionPath(root)}.tmp`,
          ...plan.operations.map(({ path }) => join(root, path)),
        ];
        const evidenceBefore = await Promise.all(evidencePaths.map(observe));
        const coordinator = await createNodeFoundationTransactionCoordinator(root);
        const status = await coordinator.inspect();
        assert.deepEqual(
          {
            state: status.state,
            operationKind: status.operationKind,
            format: status.format,
            recovery: status.recovery,
          },
          {
            state: "pending",
            operationKind: "local-mode",
            format: "local-mode-v1",
            recovery: { commandId: "detach" },
          },
        );

        const recovery = await coordinator.acquire({
          requestedMutation: "detach",
          allowRecoveryOf: "local-mode",
        });
        await recovery.release();
        for (const requestedMutation of ["attach", "document-authoring"]) {
          await assert.rejects(
            coordinator.acquire({ requestedMutation }),
            (error) =>
              error instanceof FoundationTransactionError &&
              error.status.operationKind === "local-mode",
          );
        }
        await assert.rejects(
          applyFilesystemScaffold(root, plan),
          (error) => error?.code === "SCAFFOLD_RECOVERY_REQUIRED",
        );
        await assert.rejects(
          recoverFilesystemScaffold(root),
          (error) => error?.code === "SCAFFOLD_RECOVERY_REQUIRED",
        );
        assert.deepEqual(
          await Promise.all(evidencePaths.map(observe)),
          evidenceBefore,
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});

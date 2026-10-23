import assert from "node:assert/strict";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { inspectKnownFileTransactionBarrier } from "../../packages/repository-mutation/dist/index.js";
import {
  applyKnownFileTransaction,
  recoverKnownFileTransaction,
} from "../../packages/repository-mutation/dist/qualification/index.js";
import { replacementPlan } from "./known-file-transaction-node-fixtures.mjs";
export async function persistedTree(
  root: string,
  ignoreOperationLock = true,
  openFile: typeof open = open,
) {
  const entries = [];
  for (const path of (await readdir(root, { recursive: true })).toSorted()) {
    // A refused recovery may retain/update its cooperative lock barrier. All
    // journal, temporary, destination and directory identities must survive.
    if (ignoreOperationLock && path === join(".agent-teams-local", "foundation-operation.lock")) {
      continue;
    }
    const full = join(root, path);
    // stat follows links as before and observes directory identities without
    // opening directories (unsupported on Windows). File evidence comes only
    // from one handle, even if the pathname is replaced after it is opened.
    let metadata = await stat(full, { bigint: true });
    let bytes;
    if (metadata.isFile()) {
      const handle = await openFile(full, "r");
      try {
        metadata = await handle.stat({ bigint: true });
        assert.ok(metadata.isFile(), "Persisted file changed type during observation.");
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    }
    entries.push({
      path,
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
      mode: metadata.mode,
      // APFS counts the intentionally retained lock file in its parent's links.
      // Keep every journal/file link count and every directory identity exact.
      nlink: ignoreOperationLock && path === ".agent-teams-local" ? undefined : metadata.nlink,
      bytes,
    });
  }
  return entries;
}

export async function assertManualOnly(root: string, expectedError: RegExp) {
  const before = await persistedTree(root);
  const inspection = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  assert.equal(inspection.state, "recovery-required");
  assert.equal(inspection.recoverableByInstalledBuild, false);
  await assert.rejects(recoverKnownFileTransaction({ consumerRoot: root }), expectedError);
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan() }),
    /recover/u,
  );
  assert.deepEqual(await persistedTree(root), before);
  const after = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  assert.equal(after.state, "recovery-required");
  assert.equal(after.recoverableByInstalledBuild, false);
}

import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readBoundedRegularFile } from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-bounded-regular-file.js";
import { cleanupIdentityMatchingOwnedTemporary } from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-cleanup-owned-temporary.js";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "owned-temporary-cleanup-"));
  const temporaryPath = join(parent, "result.tmp");
  await writeFile(temporaryPath, "owned\n");
  const observed = await readBoundedRegularFile(temporaryPath, 64);
  assert.equal(observed.outcome, "read");
  return { parent, temporaryPath, expectedIdentity: observed.identity };
}

function options(paths, overrides = {}) {
  const syncs = [];
  return {
    syncs,
    value: {
      allowUnsupportedDirectoryDurability: false,
      displayPath: "result.tmp",
      expectedIdentity: paths.expectedIdentity,
      parent: paths.parent,
      async rm(path) {
        await rm(path);
      },
      async syncDirectory(path) {
        syncs.push(path);
        return "supported";
      },
      temporaryPath: paths.temporaryPath,
      operations: {
        quarantineToken: () => "deterministic",
        ...overrides,
      },
    },
  };
}

test("atomically quarantines and durably removes the expected temporary", async () => {
  const paths = await fixture();
  try {
    const cleanup = options(paths);
    assert.equal(await cleanupIdentityMatchingOwnedTemporary(cleanup.value), "removed");
    assert.deepEqual(cleanup.syncs, [paths.parent, paths.parent]);
    assert.deepEqual(await readdir(paths.parent), []);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("preserves a foreign replacement captured immediately before rename", async () => {
  const paths = await fixture();
  try {
    const cleanup = options(paths, {
      async rename(source, destination) {
        await rename(source, `${source}.owned`);
        await writeFile(source, "foreign\n");
        await rename(source, destination);
      },
    });
    assert.equal(await cleanupIdentityMatchingOwnedTemporary(cleanup.value), "different");
    assert.equal(await readFile(`${paths.temporaryPath}.owned`, "utf8"), "owned\n");
    const entries = await readdir(paths.parent);
    const quarantine = entries.find((entry) =>
      entry.includes("foundation-owned-cleanup-deterministic"));
    assert.ok(quarantine);
    assert.equal(
      await readFile(join(paths.parent, quarantine, "owned-temporary"), "utf8"),
      "foreign\n",
    );
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("never deletes a new source replacement created after quarantine rename", async () => {
  const paths = await fixture();
  try {
    const cleanup = options(paths, {
      async rename(source, destination) {
        await rename(source, destination);
        await writeFile(source, "new source\n");
      },
    });
    assert.equal(await cleanupIdentityMatchingOwnedTemporary(cleanup.value), "removed");
    assert.equal(await readFile(paths.temporaryPath, "utf8"), "new source\n");
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("fails closed when the operation-private quarantine collides", async () => {
  const paths = await fixture();
  try {
    const collision = join(
      paths.parent,
      ".result.tmp.foundation-owned-cleanup-deterministic",
    );
    await mkdir(collision);
    const cleanup = options(paths);
    assert.equal(await cleanupIdentityMatchingOwnedTemporary(cleanup.value), "different");
    assert.equal(await readFile(paths.temporaryPath, "utf8"), "owned\n");
    assert.equal((await lstat(collision)).isDirectory(), true);
    assert.deepEqual(cleanup.syncs, []);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

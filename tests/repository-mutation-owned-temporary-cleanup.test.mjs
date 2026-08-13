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
  const operations = [];
  return {
    operations,
    syncs,
    value: {
      allowUnsupportedDirectoryDurability: false,
      displayPath: "result.tmp",
      expectedIdentity: paths.expectedIdentity,
      parent: paths.parent,
      async rm(path) {
        operations.push(`rm:${path}`);
        await rm(path);
      },
      async syncDirectory(path) {
        operations.push(`sync:${path}`);
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

function transition(events) {
  return {
    async begin() {
      events.push("transition:begin");
      return {
        async complete() {
          events.push("transition:complete");
        },
      };
    },
  };
}

test("atomically quarantines and durably retires the expected temporary", async () => {
  const paths = await fixture();
  try {
    const cleanup = options(paths);
    assert.equal(await cleanupIdentityMatchingOwnedTemporary(cleanup.value), "removed");
    const quarantine = join(
      paths.parent,
      ".result.tmp.foundation-owned-cleanup-deterministic",
    );
    assert.deepEqual(cleanup.syncs, [
      quarantine,
      paths.parent,
      paths.parent,
      paths.parent,
    ]);
    assert.deepEqual(cleanup.operations, [
      `sync:${quarantine}`,
      `sync:${paths.parent}`,
      `sync:${paths.parent}`,
      `sync:${paths.parent}`,
    ]);
    assert.deepEqual(await readdir(paths.parent), [
      ".foundation-retired-evidence-",
    ]);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("destination quarantine sync failure preserves captured evidence and never succeeds", async () => {
  const paths = await fixture();
  try {
    const cleanup = options(paths);
    const quarantine = join(
      paths.parent,
      ".result.tmp.foundation-owned-cleanup-deterministic",
    );
    cleanup.value.syncDirectory = async (path) => {
      cleanup.operations.push(`sync:${path}`);
      if (path === quarantine) {
        throw new Error("destination quarantine sync failed");
      }
      return "supported";
    };
    await assert.rejects(
      cleanupIdentityMatchingOwnedTemporary(cleanup.value),
      /destination quarantine sync failed/u,
    );
    assert.deepEqual(cleanup.operations, [`sync:${quarantine}`]);
    assert.equal(
      await readFile(join(quarantine, "owned-temporary"), "utf8"),
      "owned\n",
    );
    await assert.rejects(readFile(paths.temporaryPath),
      (error) => error?.code === "ENOENT");
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

test("retains the cleanup transition when quarantine allocation collides", async () => {
  const paths = await fixture();
  try {
    const events = [];
    const collision = join(
      paths.parent,
      ".result.tmp.foundation-owned-cleanup-deterministic",
    );
    await mkdir(collision);
    const cleanup = options(paths);
    cleanup.value.transition = transition(events);
    assert.equal(
      await cleanupIdentityMatchingOwnedTemporary(cleanup.value),
      "different",
    );
    assert.deepEqual(events, ["transition:begin"]);
    assert.equal(await readFile(paths.temporaryPath, "utf8"), "owned\n");
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("durably begins the cleanup transition before quarantine rename", async () => {
  const paths = await fixture();
  try {
    const events = [];
    const cleanup = options(paths, {
      async rename(source, destination) {
        if (source === paths.temporaryPath) {
          assert.deepEqual(events, ["transition:begin"]);
          events.push("quarantine:rename");
        }
        await rename(source, destination);
      },
    });
    cleanup.value.transition = transition(events);
    assert.equal(await cleanupIdentityMatchingOwnedTemporary(cleanup.value), "removed");
    assert.deepEqual(events, [
      "transition:begin",
      "quarantine:rename",
      "transition:complete",
    ]);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("retains the cleanup transition when logical retirement fails", async () => {
  const paths = await fixture();
  try {
    const events = [];
    const cleanup = options(paths);
    cleanup.value.transition = transition(events);
    cleanup.value.operations.beforeLogicalRetirement = async () => {
      throw new Error("cleanup failed");
    };
    await assert.rejects(
      cleanupIdentityMatchingOwnedTemporary(cleanup.value),
      /cleanup failed/u,
    );
    assert.deepEqual(events, ["transition:begin"]);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("never deletes a replacement swapped after the final temporary proof", async () => {
  const paths = await fixture();
  try {
    let retiredPath;
    const cleanup = options(paths, {
      async beforeLogicalRetirement(path) {
        retiredPath = path;
        await rename(path, `${path}.owned`);
        await writeFile(path, "foreign replacement\n");
      },
    });
    assert.equal(
      await cleanupIdentityMatchingOwnedTemporary(cleanup.value),
      "different",
    );
    assert.equal(await readFile(retiredPath, "utf8"), "foreign replacement\n");
    assert.equal(await readFile(`${retiredPath}.owned`, "utf8"), "owned\n");
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("does not begin a cleanup transition for missing or foreign evidence", async () => {
  const paths = await fixture();
  try {
    const events = [];
    await rm(paths.temporaryPath);
    const missing = options(paths);
    missing.value.transition = transition(events);
    assert.equal(
      await cleanupIdentityMatchingOwnedTemporary(missing.value),
      "missing",
    );
    await writeFile(paths.temporaryPath, "foreign\n");
    const foreign = options(paths);
    foreign.value.transition = transition(events);
    assert.equal(
      await cleanupIdentityMatchingOwnedTemporary(foreign.value),
      "different",
    );
    assert.deepEqual(events, []);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("completes the transition when the owned source disappears before rename", async () => {
  const paths = await fixture();
  try {
    const events = [];
    const cleanup = options(paths, {
      async rename(source) {
        if ((await lstat(source)).isDirectory()) {
          return rename(source, join(paths.parent, ".foundation-retired-evidence-", "deterministic"));
        }
        await rm(source);
        const error = new Error("source disappeared");
        error.code = "ENOENT";
        throw error;
      },
    });
    cleanup.value.transition = transition(events);
    assert.equal(
      await cleanupIdentityMatchingOwnedTemporary(cleanup.value),
      "missing",
    );
    assert.deepEqual(events, ["transition:begin", "transition:complete"]);
    assert.deepEqual(await readdir(paths.parent), [
      ".foundation-retired-evidence-",
    ]);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeFoundationOperationLock } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-operation-lock.js";

async function createRoot() {
  return realpath(await mkdtemp(join(tmpdir(), "foundation-operation-lock-")));
}

function paths(root) {
  const directory = join(root, ".agent-teams-local");
  return { directory, lock: join(directory, "foundation-operation.lock") };
}

async function writeEvidence(root, evidence) {
  const target = paths(root);
  await mkdir(target.directory, { recursive: true });
  await writeFile(
    target.lock,
    typeof evidence === "string" ? evidence : `${JSON.stringify(evidence)}\n`,
    "utf8",
  );
  return target;
}

function activeEvidence(pid, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "active",
    host: hostname(),
    pid,
    token: randomUUID(),
    ...overrides,
  };
}

async function assertAcquireFailsClosed(root) {
  await assert.rejects(new NodeFoundationOperationLock(root).acquire(), (error) => {
    assert.equal(error.code, "LOCAL_STATE_INVALID");
    return true;
  });
}

test("never reclaims a same-host lock whose owner is still live", async () => {
  const root = await createRoot();
  try {
    await writeEvidence(root, activeEvidence(process.pid));
    await assertAcquireFailsClosed(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("preserves an empty legacy lock directory for explicit manual recovery", async () => {
  const root = await createRoot();
  try {
    const target = paths(root);
    await mkdir(target.lock, { recursive: true });
    await assertAcquireFailsClosed(root);
    assert.equal((await lstat(target.lock)).isDirectory(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("preserves foreign-host and malformed evidence", async (context) => {
  await context.test("foreign host", async () => {
    const root = await createRoot();
    try {
      const target = await writeEvidence(
        root,
        activeEvidence(2_147_483_647, { host: "remote.invalid" }),
      );
      const before = await readFile(target.lock);
      await assertAcquireFailsClosed(root);
      assert.deepEqual(await readFile(target.lock), before);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  await context.test("symbolic link", async () => {
    const root = await createRoot();
    try {
      const target = paths(root);
      const external = join(root, "external-lock");
      await mkdir(target.directory);
      await writeFile(external, "external\n");
      await symlink(external, target.lock, "file");
      await assertAcquireFailsClosed(root);
      assert.equal(await readFile(external, "utf8"), "external\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  await context.test("partial canonical file", async () => {
    const root = await createRoot();
    try {
      const target = await writeEvidence(root, "partial");
      const before = await readFile(target.lock);
      await assertAcquireFailsClosed(root);
      assert.deepEqual(await readFile(target.lock), before);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

test("preserves a stale or partial takeover claim for manual recovery", async () => {
  const root = await createRoot();
  try {
    const deadOwner = activeEvidence(2_147_483_647);
    const target = await writeEvidence(root, deadOwner);
    const claimPath = `${target.lock}.claim.${deadOwner.token}`;
    await writeFile(claimPath, "partial\n", "utf8");
    const lockBefore = await readFile(target.lock);
    const claimBefore = await readFile(claimPath);
    await assertAcquireFailsClosed(root);
    assert.deepEqual(await readFile(target.lock), lockBefore);
    assert.deepEqual(await readFile(claimPath), claimBefore);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("ignores a residual claim from an older lock generation", async () => {
  const root = await createRoot();
  try {
    const deadOwner = activeEvidence(2_147_483_647);
    const target = await writeEvidence(root, deadOwner);
    await writeFile(`${target.lock}.claim.${randomUUID()}`, "partial\n", "utf8");
    const release = await new NodeFoundationOperationLock(root).acquire();
    await release();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("serializes two reclaimers of one provably dead owner", async () => {
  const root = await createRoot();
  try {
    await writeEvidence(root, activeEvidence(2_147_483_647));
    const attempts = await Promise.allSettled([
      new NodeFoundationOperationLock(root).acquire(),
      new NodeFoundationOperationLock(root).acquire(),
    ]);
    const acquired = attempts.filter(({ status }) => status === "fulfilled");
    assert.equal(acquired.length, 1);
    assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
    await acquired[0].value();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("release is idempotent and an old releaser cannot delete a successor", async () => {
  const root = await createRoot();
  try {
    const target = paths(root);
    const release = await new NodeFoundationOperationLock(root).acquire();
    const displaced = `${target.lock}.displaced`;
    await rename(target.lock, displaced);
    const successor = activeEvidence(process.pid);
    await writeEvidence(root, successor);
    await assert.rejects(release(), (error) => error.code === "LOCAL_STATE_INVALID");
    assert.deepEqual(
      JSON.parse(await readFile(target.lock, "utf8")),
      successor,
    );
    assert.equal((await lstat(displaced)).isFile(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("coalesces concurrent release calls without deleting unrelated state", async () => {
  const root = await createRoot();
  try {
    const release = await new NodeFoundationOperationLock(root).acquire();
    await Promise.all([release(), release(), release()]);
    await release();
    await assert.rejects(lstat(paths(root).lock), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("release preserves a foreign predictable retirement destination", async () => {
  const root = await createRoot();
  try {
    const target = paths(root);
    const release = await new NodeFoundationOperationLock(root).acquire();
    const owned = JSON.parse(await readFile(target.lock, "utf8"));
    const legacyDestination = `${target.lock}.released.${owned.token}`;
    await writeFile(legacyDestination, "foreign retirement evidence\n", "utf8");

    await release();

    assert.equal(
      await readFile(legacyDestination, "utf8"),
      "foreign retirement evidence\n",
    );
    const retirement = (await readdir(target.directory)).find((entry) =>
      entry.startsWith(`foundation-operation.lock.released.${owned.token}.`),
    );
    assert.ok(retirement);
    assert.deepEqual(
      JSON.parse(await readFile(join(target.directory, retirement, "evidence"), "utf8")),
      owned,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("release preserves a substituted retirement pathname", async () => {
  const root = await createRoot();
  try {
    let foreignPath;
    const release = await new NodeFoundationOperationLock(root, {
      async faultInjector(point) {
        if (point.phase !== "after-release-retirement") {
          return;
        }
        await rename(point.path, `${point.path}.owned-original`);
        await writeFile(point.path, "foreign substituted evidence\n", "utf8");
        foreignPath = point.path;
      },
    }).acquire();

    await assert.rejects(release(), (error) => error.code === "LOCAL_STATE_INVALID");
    assert.ok(foreignPath);
    assert.equal(await readFile(foreignPath, "utf8"), "foreign substituted evidence\n");
    assert.equal((await lstat(`${foreignPath}.owned-original`)).isFile(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("retained transaction barrier survives its owner and is claimable by a new coordinator", async () => {
  const root = await createRoot();
  try {
    const target = paths(root);
    const release = await new NodeFoundationOperationLock(root).acquire();
    await release({ retainTransactionBarrier: true });
    const barrier = JSON.parse(await readFile(target.lock, "utf8"));
    assert.equal(barrier.kind, "transaction-barrier");
    const successorRelease = await new NodeFoundationOperationLock(root).acquire();
    await successorRelease({ retainTransactionBarrier: true });
    assert.equal(
      JSON.parse(await readFile(target.lock, "utf8")).kind,
      "transaction-barrier",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

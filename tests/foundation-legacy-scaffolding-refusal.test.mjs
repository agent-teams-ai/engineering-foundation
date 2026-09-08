import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-coordinator.js";
import { FoundationTransactionError } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-error.js";
import { createNodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-slot.js";
import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-coordinator.js";
import { createRoot, slotPath, writeJson, coordinatorWith, installedBuildIdentity } from "./support/foundation-transaction-observation-fixtures.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const legacyFixtureRoot = join(repositoryRoot, "tests", "fixtures", "legacy-scaffolding-0.9.0");

async function legacySlot(root, installedVersion = "1.1.0") {
  await mkdir(dirname(slotPath(root)), { recursive: true });
  await cp(join(legacyFixtureRoot, "journal.json"), slotPath(root));
  return createNodeFoundationTransactionSlot({ consumerRoot: root, installedBuildIdentity, installedVersion });
}

async function evidenceIdentity(path) {
  const stat = await lstat(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs,
    ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, size: stat.size,
    mode: stat.mode, nlink: stat.nlink };
}

test("recognizes authentic 0.9.0 legacy bytes and refuses before acquiring or writing", async (context) => {
  for (const kind of ["absent", "regular", "directory", "symlink", "oversized"]) {
    await context.test(kind, async () => {
      const root = await createRoot();
      try {
        const slot = await legacySlot(root);
        const lockPath = join(dirname(slotPath(root)), "foundation-operation.lock");
        if (kind === "regular") {
          await cp(join(legacyFixtureRoot, "operation-lock.txt"), lockPath);
        } else if (kind === "directory") {
          await mkdir(lockPath);
          await writeFile(join(lockPath, "owner-evidence"), "preserve\n");
        } else if (kind === "symlink") {
          await symlink(slotPath(root), lockPath);
        } else if (kind === "oversized") {
          await writeFile(lockPath, Buffer.alloc(64 * 1024 + 1));
        }
        const journalBefore = await readFile(slotPath(root));
        const journalIdentity = await evidenceIdentity(slotPath(root));
        const directoryIdentity = await evidenceIdentity(dirname(slotPath(root)));
        const lockIdentity = kind === "absent" ? undefined : await evidenceIdentity(lockPath);
        const lockBefore = kind === "regular" || kind === "oversized" ? await readFile(lockPath) : undefined;
        const status = await slot.inspect();
        const manual = ["regular", "symlink", "oversized"].includes(kind);
        assert.equal(status.state, manual ? "manual-recovery-required" : "pending");
        assert.equal(status.operationKind, "scaffolding");
        assert.equal(status.foundationVersion, "0.9.0");
        assert.ok(status.diagnostics.some(({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"));
        if (manual) {
          assert.equal(status.reason, "recovery-handler-unavailable");
          assert.equal(status.recovery, undefined);
          assert.match(status.diagnostics[0].message, /No supported automatic handoff/u);
          if (kind === "regular") {assert.match(status.diagnostics[0].message, /regular operation lock prevents/u);}
        } else {
          assert.equal(status.format, "legacy-scaffolding-v1");
          assert.deepEqual(status.recovery, { commandId: "scaffold-recover", exactFoundationVersion: "0.9.0" });
        }
        let acquisitions = 0;
        const coordinator = new FoundationTransactionCoordinator({ slot, lock: {
          async acquire() { acquisitions += 1; throw new Error("must not acquire"); }
        } });
        for (const requestedMutation of ["attach", "detach", "scaffolding", "known-file-transaction", "document-authoring"]) {
          await assert.rejects(coordinator.acquire({ requestedMutation, allowRecoveryOf: "scaffolding" }), error => {
            assert.ok(error instanceof FoundationTransactionError);
            assert.deepEqual(error.status, status);
            return true;
          });
        }
        assert.equal(acquisitions, 0);
        // Also exercise the production physical adapter; no barrier may be made
        // or taken over on this stable refusal.
        const physical = await createNodeFoundationTransactionCoordinator(root);
        await assert.rejects(physical.acquire({ requestedMutation: "attach" }), FoundationTransactionError);
        assert.deepEqual(await readFile(slotPath(root)), journalBefore);
        assert.deepEqual(await evidenceIdentity(slotPath(root)), journalIdentity);
        assert.deepEqual(await evidenceIdentity(dirname(slotPath(root))), directoryIdentity);
        if (kind === "absent") {
          await assert.rejects(lstat(lockPath), { code: "ENOENT" });
        } else {
          assert.deepEqual(await evidenceIdentity(lockPath), lockIdentity);
          if (lockBefore !== undefined) {assert.deepEqual(await readFile(lockPath), lockBefore);}
          if (kind === "directory") {assert.equal(await readFile(join(lockPath, "owner-evidence"), "utf8"), "preserve\n");}
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

test("idle preflight still inspects a newly appeared legacy journal under lock and retains release evidence", async () => {
  const root = await createRoot();
  try {
    const slot = createNodeFoundationTransactionSlot({ consumerRoot: root, installedBuildIdentity, installedVersion: "1.1.0" });
    let inspections = 0;
    let acquisitions = 0;
    const releases = [];
    const releaseFailure = new Error("late refusal release failed");
    const coordinator = new FoundationTransactionCoordinator({
      slot: { async inspect() { inspections += 1; return slot.inspect(); } },
      lock: { async acquire() {
        acquisitions += 1;
        await legacySlot(root);
        await cp(join(legacyFixtureRoot, "operation-lock.txt"), join(dirname(slotPath(root)), "foundation-operation.lock"));
        return async options => { releases.push(options); throw releaseFailure; };
      } }
    });
    await assert.rejects(coordinator.acquire({ requestedMutation: "attach" }), error => {
      assert.ok(error instanceof FoundationTransactionError);
      assert.equal(error.status.foundationVersion, "0.9.0");
      assert.equal(error.status.state, "manual-recovery-required");
      assert.equal(error.status.recovery, undefined);
      assert.equal(error.cause, releaseFailure);
      return true;
    });
    assert.equal(inspections, 2);
    assert.equal(acquisitions, 1);
    assert.deepEqual(releases, [{ retainTransactionBarrier: true }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exact 0.9.0 reader remains admitted without an incompatible lock", async () => {
  const root = await createRoot();
  try {
    const slot = await legacySlot(root, "0.9.0");
    const status = await slot.inspect();
    assert.equal(status.state, "pending");
    assert.equal(status.foundationVersion, "0.9.0");
    const fixture = coordinatorWith(status);
    const lease = await fixture.coordinator.acquire({ requestedMutation: "scaffolding", allowRecoveryOf: "scaffolding" });
    await lease.release();
    assert.equal(fixture.releaseCount(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy lock aliases and redirected state do not advertise an executable recovery route", async (context) => {
  for (const kind of ["alias", "redirected-state"]) {
    await context.test(kind, async () => {
      const root = await createRoot();
      const redirected = await createRoot();
      try {
        const slot = await legacySlot(root);
        const directory = dirname(slotPath(root));
        if (kind === "alias") {
          await cp(join(legacyFixtureRoot, "operation-lock.txt"), join(directory, "FOUNDATION-OPERATION.LOCK"));
        } else {
          await rename(directory, join(redirected, "state"));
          await symlink(join(redirected, "state"), directory, "junction");
        }
        const journalBefore = await readFile(slotPath(root));
        const identityBefore = await evidenceIdentity(slotPath(root));
        let acquisitions = 0;
        const coordinator = new FoundationTransactionCoordinator({ slot, lock: {
          async acquire() { acquisitions += 1; throw new Error("must not acquire"); }
        } });
        await assert.rejects(coordinator.acquire({ requestedMutation: "attach" }), error => {
          assert.ok(error instanceof FoundationTransactionError);
          assert.equal(error.status.state, "manual-recovery-required");
          assert.equal(error.status.foundationVersion, "0.9.0");
          assert.equal(error.status.recovery, undefined);
          return true;
        });
        assert.equal(acquisitions, 0);
        assert.deepEqual(await readFile(slotPath(root)), journalBefore);
        assert.deepEqual(await evidenceIdentity(slotPath(root)), identityBefore);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(redirected, { recursive: true, force: true });
      }
    });
  }
});

test("legacy lock enrichment preserves conservative coexisting and malformed diagnoses", async (context) => {
  for (const kind of ["local-mode", "temporary", "malformed"]) {
    await context.test(kind, async () => {
      const root = await createRoot();
      try {
        const slot = await legacySlot(root);
        const directory = dirname(slotPath(root));
        await cp(join(legacyFixtureRoot, "operation-lock.txt"), join(directory, "foundation-operation.lock"));
        if (kind === "local-mode") {await mkdir(join(directory, "foundation-registry-backup"));}
        if (kind === "temporary") {await writeFile(`${slotPath(root)}.tmp`, "preserve");}
        if (kind === "malformed") {
          const journal = JSON.parse(await readFile(slotPath(root), "utf8"));
          journal.operations[0].path += ".forged";
          await writeJson(slotPath(root), journal);
        }
        const status = await slot.inspect();
        assert.equal(status.state, "manual-recovery-required");
        assert.equal(status.reason, kind === "local-mode" ? "multiple-transactions" : kind === "temporary" ? "orphan-temporary" : "corrupt-or-incompatible");
        assert.equal(status.foundationVersion, undefined);
        assert.equal(status.recovery, undefined);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

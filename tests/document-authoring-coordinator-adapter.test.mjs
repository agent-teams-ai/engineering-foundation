import assert from "node:assert/strict";
import test from "node:test";

import { NodeDocumentTransactionCoordinator } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-transaction-coordinator.js";

const buildIdentity = `sha256:${"a".repeat(64)}`;

function idle() {
  return { state: "idle", diagnostics: [] };
}

function exactDocument() {
  return {
    state: "pending",
    operationKind: "document-authoring",
    format: "document-authoring-envelope-v3",
    foundationVersion: "0.16.0",
    foundationBuildIdentity: buildIdentity,
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: "0.16.0",
      exactFoundationBuildIdentity: buildIdentity,
    },
    diagnostics: [{ code: "FOUNDATION_TRANSACTION_ACTIVE", message: "active" }],
  };
}

function fixture(initial) {
  let status = initial;
  const acquisitions = [];
  const releases = [];
  const foundation = {
    async inspect() {
      if (status instanceof Error) {
        throw status;
      }
      return status;
    },
    async acquire(options) {
      acquisitions.push(options);
      return {
        status,
        async release(releaseOptions) {
          releases.push(releaseOptions);
        },
      };
    },
  };
  return {
    acquisitions,
    coordinator: new NodeDocumentTransactionCoordinator(foundation),
    releases,
    setStatus(next) {
      status = next;
    },
  };
}

test("maps only the exact document v3 journal v2 route to recoverable", async () => {
  const exact = fixture(exactDocument());
  assert.deepEqual(await exact.coordinator.inspect(), { state: "recoverable" });

  const mismatched = exactDocument();
  mismatched.recovery.exactFoundationBuildIdentity = `sha256:${"b".repeat(64)}`;
  const mismatchStatus = await fixture(mismatched).coordinator.inspect();
  assert.equal(mismatchStatus.state, "manual-recovery-required");

  const wrongBuild = exactDocument();
  wrongBuild.diagnostics = [{
    code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
    message: "different installed build",
  }];
  assert.deepEqual(await fixture(wrongBuild).coordinator.inspect(), {
    state: "manual-recovery-required",
    reason: "different installed build",
  });

  const foreign = {
    state: "pending",
    operationKind: "local-mode",
    format: "local-mode-v1",
    recovery: { commandId: "detach" },
    diagnostics: [{ code: "FOUNDATION_TRANSACTION_ACTIVE", message: "detach first" }],
  };
  assert.deepEqual(await fixture(foreign).coordinator.inspect(), {
    state: "manual-recovery-required",
    reason: "detach first",
  });
});

test("requests an idle-only apply lease and an exact document recovery lease", async () => {
  const applying = fixture(idle());
  const applyLease = await applying.coordinator.acquire({ mode: "apply" });
  assert.deepEqual(applyLease.status, { state: "idle" });
  assert.deepEqual(applying.acquisitions, [{
    requestedMutation: "document-authoring",
  }]);
  await applyLease.release();

  const recovering = fixture(exactDocument());
  const recoverLease = await recovering.coordinator.acquire({ mode: "recover" });
  assert.deepEqual(recoverLease.status, { state: "recoverable" });
  assert.deepEqual(recovering.acquisitions, [{
    requestedMutation: "document-authoring",
    allowRecoveryOf: "document-authoring",
  }]);
});

test("releases normally only after all transaction evidence is durably gone", async () => {
  const clean = fixture(idle());
  const cleanLease = await clean.coordinator.acquire({ mode: "apply" });
  await cleanLease.release();
  assert.deepEqual(clean.releases, [{ retainTransactionBarrier: false }]);

  const pending = fixture(idle());
  const pendingLease = await pending.coordinator.acquire({ mode: "apply" });
  pending.setStatus(exactDocument());
  await pendingLease.release();
  assert.deepEqual(pending.releases, [{ retainTransactionBarrier: true }]);

  const explicitlyRetained = fixture(idle());
  const retainedLease = await explicitlyRetained.coordinator.acquire({ mode: "apply" });
  await retainedLease.release({ retainTransactionBarrier: true });
  await retainedLease.release();
  assert.deepEqual(explicitlyRetained.releases, [{ retainTransactionBarrier: true }]);
});

test("retains the barrier when post-operation evidence cannot be inspected", async () => {
  const value = fixture(idle());
  const lease = await value.coordinator.acquire({ mode: "apply" });
  value.setStatus(new Error("slot unreadable"));
  await assert.rejects(lease.release(), /slot unreadable/u);
  assert.deepEqual(value.releases, [{ retainTransactionBarrier: true }]);
});

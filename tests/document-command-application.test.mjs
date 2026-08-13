import assert from "node:assert/strict";
import test from "node:test";

import { RunDocumentDoctor } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/run-document-doctor.js";
import { RunDocumentNew } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/run-document-new.js";
import { RunDocumentRecover } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/run-document-recover.js";

const digest = `sha256:${"a".repeat(64)}`;
const plan = { destination: "docs/decisions/0083-test.md", planDigest: digest };
const successfulReceipt = {
  outcome: "applied",
  receiptDigest: digest,
  diagnostics: []
};

function newHarness(overrides = {}) {
  const calls = [];
  return {
    calls,
    subject: new RunDocumentNew({
      async inspect() { calls.push("inspect"); return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
      async plan() { calls.push("plan"); return plan; },
      async apply() { calls.push("apply"); return successfulReceipt; },
      reachability: {
        async project() {
          calls.push("reachability");
          return { state: "manual-required", indexPath: "docs/README.md", markdownLink: "[ADR-0083](decisions/0083-test.md)" };
        }
      },
      structure: {
        async verify() { calls.push("verify"); return { valid: true, diagnostics: [] }; }
      },
      ...overrides
    })
  };
}

test("docs new dry-run plans a preview without reservation or mutation", async () => {
  const harness = newHarness();
  const result = await harness.subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: true
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.envelope.schemaVersion, 2);
  assert.deepEqual(result.envelope.result, {
    kind: "new",
    documentPath: plan.destination,
    writeState: "preview",
    reservation: "none",
    reachability: {
      state: "manual-required",
      indexPath: "docs/README.md",
      markdownLink: "[ADR-0083](decisions/0083-test.md)"
    }
  });
  assert.deepEqual(harness.calls, ["inspect", "plan", "reachability"]);
});

test("docs new reports an already-applied replay as success and verifies structure", async () => {
  const harness = newHarness({
    async apply() {
      harness.calls.push("apply");
      return { ...successfulReceipt, outcome: "already-applied" };
    }
  });
  const result = await harness.subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.envelope.result.writeState, "already-applied");
  assert.deepEqual(harness.calls, ["inspect", "plan", "reachability", "apply", "verify"]);
});

test("docs new blocks planning when transaction recovery is pending", async () => {
  const harness = newHarness({
    async inspect() {
      harness.calls.push("inspect");
      return {
        schemaVersion: 1, state: "recoverable", operationKind: "document-authoring",
        format: "document-authoring-envelope-v3", foundationVersion: "0.16.0",
        foundationBuildIdentity: digest,
        recovery: { commandId: "docs-recover", exactFoundationVersion: "0.16.0", exactFoundationBuildIdentity: digest },
        diagnostics: []
      };
    }
  });
  const result = await harness.subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.outcome, "recovery-required");
  assert.deepEqual(harness.calls, ["inspect"]);
});

test("docs new cancellation is 130 before publication", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await newHarness().subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false,
    signal: controller.signal
  });
  assert.equal(result.exitCode, 130);
  assert.equal(result.envelope.outcome, "cancelled");
});

test("docs new post-publication cancellation is recovery-required, never 130", async () => {
  const harness = newHarness({
    structure: {
      async verify() { const error = new Error("cancelled"); error.name = "AbortError"; throw error; }
    }
  });
  const result = await harness.subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.outcome, "recovery-required");
});

test("docs doctor projects exact recovery and unknown versions", async () => {
  const recoverable = await new RunDocumentDoctor({
    async inspect() {
      return {
        schemaVersion: 1, state: "recoverable", operationKind: "document-authoring",
        format: "document-authoring-envelope-v3", foundationVersion: "0.16.0",
        foundationBuildIdentity: digest,
        recovery: { commandId: "docs-recover", exactFoundationVersion: "0.16.0", exactFoundationBuildIdentity: digest },
        diagnostics: [{ code: "FOUNDATION_TRANSACTION_ACTIVE", message: "pending" }]
      };
    }
  }).execute({ consumerRoot: "/fixture" });
  assert.equal(recoverable.envelope.result.recoveryClass, "auto-recoverable");
  assert.equal(recoverable.envelope.result.foundationVersion, "0.16.0");

  const unknown = await new RunDocumentDoctor({
    async inspect() {
      return {
        schemaVersion: 1, state: "manual-recovery-required", reason: "version mismatch",
        operationKind: "local-mode",
        diagnostics: [{ code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH", message: "use exact version" }]
      };
    }
  }).execute({ consumerRoot: "/fixture" });
  assert.equal(unknown.envelope.result.transactionState, "unknown-version");
  assert.equal(unknown.envelope.result.protocolKind, "local-mode");
});

test("docs recover is a no-op when idle and refuses manual evidence", async () => {
  let recoverCalls = 0;
  const idle = await new RunDocumentRecover({
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async recover() { recoverCalls += 1; return successfulReceipt; }
  }).execute({ consumerRoot: "/fixture" });
  assert.equal(idle.envelope.result.transactionState, "no-pending-transaction");
  assert.equal(recoverCalls, 0);

  const manual = await new RunDocumentRecover({
    async inspect() {
      return {
        schemaVersion: 1, state: "manual-recovery-required", reason: "tampered",
        diagnostics: [{ code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED", message: "inspect manually" }]
      };
    },
    async recover() { recoverCalls += 1; return successfulReceipt; }
  }).execute({ consumerRoot: "/fixture" });
  assert.equal(manual.exitCode, 1);
  assert.equal(manual.envelope.result.transactionState, "manual-required");
  assert.equal(recoverCalls, 0);
});

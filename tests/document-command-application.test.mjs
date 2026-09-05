import assert from "node:assert/strict";
import test from "node:test";

import { RunDocumentDoctor } from "../packages/document-authoring/dist/application/use-cases/run-document-doctor.js";
import { RunDocumentNew } from "../packages/document-authoring/dist/application/use-cases/run-document-new.js";
import { RunDocumentRecover } from "../packages/document-authoring/dist/application/use-cases/run-document-recover.js";
import { assertSchema } from "../packages/document-authoring/dist/schema-catalog.js";
import { DocumentAuthoringError } from "../packages/document-authoring/dist/errors.js";

const digest = `sha256:${"a".repeat(64)}`;
const plan = {
  destination: "docs/decisions/0083-test.md",
  planDigest: digest,
  intent: { title: "Test document" },
  authority: { profile: { path: "profile.yaml" } }
};
const successfulReceipt = {
  outcome: "applied",
  receiptDigest: digest,
  diagnostics: []
};
const environment = {
  async inspect() {
    return {
      installedFoundationVersion: "0.16.0",
      installedFoundationBuildIdentity: digest,
      filesystem: {
        basis: "platform-contract",
        strictDirectoryDurability: "platform-supported",
      },
    };
  },
};

function newHarness(overrides = {}) {
  const calls = [];
  return {
    calls,
    subject: new RunDocumentNew({
      async inspect() { calls.push("inspect"); return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
      async plan() { calls.push("plan"); return plan; },
      async apply() { calls.push("apply"); return successfulReceipt; },
      similar: {
        async advise() { calls.push("similar"); return { matches: [], query: "test" }; }
      },
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

test("docs new projects consumer input errors and preserves unexpected failures", async () => {
  const message = "Invalid consumer. ".repeat(100);
  for (const [error, outcome, exitCode] of [
    [new DocumentAuthoringError("CONSUMER_INVALID", message), "invalid-input", 2],
    [Object.assign(new Error(message), { code: "CONSUMER_INVALID" }), "execution-failure", 3]
  ]) {
    const harness = newHarness({ async plan() { throw error; } });
    const result = await harness.subject.execute({
      consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false
    });
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.envelope.outcome, outcome);
    assert.equal(result.envelope.diagnostics[0].ruleId, `docs.new.${outcome}`);
    assert.equal(result.envelope.diagnostics[0].message, message.slice(0, 1_000));
    if (outcome === "invalid-input") {
      assert.equal(result.envelope.diagnostics[0].phase, "input");
    }
    assert.deepEqual(harness.calls, ["inspect"]);
  }
});

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
  assert.deepEqual(harness.calls, ["inspect", "plan", "similar", "reachability"]);
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
  assert.deepEqual(harness.calls, ["inspect", "plan", "similar", "reachability", "apply", "verify"]);
});

test("docs new emits deterministic similar-document advice without blocking", async () => {
  const harness = newHarness({
    similar: {
      async advise() {
        harness.calls.push("similar");
        return {
          matches: [{ id: "ADR-0007", repositoryPath: "docs/adr/0007-existing.md" }],
          query: "Exact title"
        };
      }
    }
  });
  const result = await harness.subject.execute({
    consumerRoot: "/fixture",
    profilePath: "profile.yaml",
    intent: { title: "Exact title" },
    dryRun: true
  });
  assert.equal(result.envelope.outcome, "success");
  assert.deepEqual(result.envelope.diagnostics, [{
    ruleId: "document.new.similar-documents",
    severity: "info",
    phase: "planning",
    subject: "document.new",
    message: "1 existing document(s) contain the exact title query. Review them before publishing if they overlap.",
    remediation: { commandId: "docs.find", args: { text: "Exact title" } }
  }]);
});

test("docs new bounds similar-document diagnostics independently of match IDs", async () => {
  const harness = newHarness({
    similar: {
      async advise() {
        return {
          matches: Array.from({ length: 16 }, (_value, index) => ({
            id: `document.${String(index).padStart(3, "0")}.${"x".repeat(90)}`,
            repositoryPath: `docs/${index}.md`,
          })),
          query: "Bounded advisory",
        };
      },
    },
  });
  const execution = await harness.subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml",
    intent: { title: "Bounded advisory" }, dryRun: true,
  });

  assert.equal(execution.envelope.diagnostics[0]?.subject, "document.new");
  await assertSchema(
    "document-command-envelope/v2",
    execution.envelope,
    "bounded-similar-document-advice",
  );
});

test("docs new fails closed on advisory failure and preserves cancellation", async () => {
  const failed = newHarness({
    similar: { async advise() { throw new Error("catalog unavailable"); } }
  });
  const result = await failed.subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml",
    intent: { title: "Exact title" }, dryRun: true
  });
  assert.equal(result.envelope.outcome, "execution-failure");
  assert.deepEqual(failed.calls, ["inspect", "plan"]);

  const controller = new AbortController();
  const cancelled = newHarness({
    similar: {
      async advise() {
        controller.abort();
        throw new Error("catalog observation cancelled");
      }
    }
  });
  const cancelledResult = await cancelled.subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml",
    intent: { title: "Exact title" }, dryRun: true, signal: controller.signal
  });
  assert.equal(cancelledResult.exitCode, 130);
  assert.equal(cancelledResult.envelope.outcome, "cancelled");
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

test("docs new never invents docs recovery for foreign or corrupt evidence", async () => {
  for (const inspection of [
    {
      schemaVersion: 1, state: "manual-recovery-required", reason: "corrupt",
      transactionKind: "corrupt", diagnostics: []
    },
    {
      schemaVersion: 1, state: "manual-recovery-required", reason: "foreign",
      operationKind: "scaffolding", transactionKind: "scaffold", diagnostics: []
    }
  ]) {
    const harness = newHarness({ async inspect() { return inspection; } });
    const result = await harness.subject.execute({
      consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false
    });
    assert.equal(result.envelope.diagnostics[0].remediation, undefined);
  }
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

test("docs new post-publication cancellation is a committed violation, never 130", async () => {
  const harness = newHarness({
    structure: {
      async verify() { const error = new Error("cancelled"); error.name = "AbortError"; throw error; }
    }
  });
  const result = await harness.subject.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.outcome, "violation");
  assert.equal(result.envelope.result.documentPath, plan.destination);
  assert.equal(result.envelope.result.writeState, "applied");
  assert.deepEqual(result.envelope.result.reachability, {
    state: "manual-required",
    indexPath: "docs/README.md",
    markdownLink: "[ADR-0083](decisions/0083-test.md)"
  });
});

test("docs doctor projects exact recovery and unknown versions", async () => {
  const recoverable = await new RunDocumentDoctor({
    environment,
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
  assert.deepEqual(recoverable.envelope.result.recoveryCommand, {
    commandId: "docs.recover",
    args: {
      consumerRoot: "/fixture",
      exactFoundationVersion: "0.16.0",
      exactFoundationBuildIdentity: digest
    }
  });
  assert.deepEqual(recoverable.envelope.diagnostics[0].remediation,
    recoverable.envelope.result.recoveryCommand);

  const unknown = await new RunDocumentDoctor({
    environment,
    async inspect() {
      return {
        schemaVersion: 1, state: "manual-recovery-required", reason: "version mismatch",
        operationKind: "local-mode",
        diagnostics: [{ code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH", message: "use exact version" }]
      };
    }
  }).execute({ consumerRoot: "/fixture" });
  assert.equal(unknown.envelope.result.transactionState, "version-mismatch");
  assert.equal(unknown.envelope.result.protocolKind, "local-mode");
  assert.equal(unknown.envelope.result.recoveryCommand, undefined);
});

test("docs doctor cancellation is 130 before and after inspection", async () => {
  const before = new AbortController();
  before.abort();
  const cancelledBefore = await new RunDocumentDoctor({
    environment,
    async inspect() { throw new Error("must not inspect"); }
  }).execute({ consumerRoot: "/fixture", signal: before.signal });
  assert.equal(cancelledBefore.exitCode, 130);
  assert.equal(cancelledBefore.envelope.outcome, "cancelled");

  const after = new AbortController();
  const cancelledAfter = await new RunDocumentDoctor({
    environment,
    async inspect() {
      after.abort();
      return { schemaVersion: 1, state: "idle", diagnostics: [] };
    }
  }).execute({ consumerRoot: "/fixture", signal: after.signal });
  assert.equal(cancelledAfter.exitCode, 130);
  assert.equal(cancelledAfter.envelope.outcome, "cancelled");
});

test("docs doctor preserves exact version and build recovery authority", async () => {
  const result = await new RunDocumentDoctor({
    environment,
    async inspect() {
      return {
        schemaVersion: 1,
        state: "manual-recovery-required",
        reason: "exact external handler required",
        operationKind: "document-authoring",
        transactionKind: "version-mismatch",
        foundationVersion: "0.14.7",
        foundationBuildIdentity: digest,
        recovery: {
          commandId: "docs-recover",
          args: {
            exactFoundationVersion: "0.14.7",
            exactFoundationBuildIdentity: digest
          }
        },
        diagnostics: [{
          code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
          message: "exact handler required"
        }]
      };
    }
  }).execute({ consumerRoot: "/fixture" });
  assert.deepEqual(result.envelope.result.recoveryCommand, {
    commandId: "docs.recover",
    args: {
      consumerRoot: "/fixture",
      exactFoundationVersion: "0.14.7",
      exactFoundationBuildIdentity: digest
    }
  });
});

test("docs new exact recovery remediation retains non-cwd consumer root", async () => {
  const consumerRoot = "/disposable/non-cwd-consumer";
  const harness = newHarness({
    async inspect() {
      return {
        schemaVersion: 1, state: "recoverable", operationKind: "document-authoring",
        format: "document-authoring-envelope-v3", foundationVersion: "0.16.0",
        foundationBuildIdentity: digest,
        recovery: {
          commandId: "docs-recover", exactFoundationVersion: "0.16.0",
          exactFoundationBuildIdentity: digest
        },
        diagnostics: []
      };
    }
  });
  const result = await harness.subject.execute({
    consumerRoot, profilePath: "profile.yaml", intent: {}, dryRun: false
  });
  assert.deepEqual(result.envelope.diagnostics[0].remediation, {
    commandId: "docs.recover",
    args: {
      consumerRoot,
      exactFoundationVersion: "0.16.0",
      exactFoundationBuildIdentity: digest
    }
  });
});

test("docs new sends manual recovery receipts to doctor and normalizes Windows roots", async () => {
  const harness = newHarness({
    async apply() {
      return {
        outcome: "manual-recovery-required",
        diagnostics: [{
          ruleId: "document.writer.manual-recovery",
          severity: "error",
          phase: "recovery",
          subject: "document.transaction",
          message: "Manual inspection is required.",
        }],
        commit: {
          state: "manual-recovery-required",
          publication: "unknown",
          atomicity: "not-applicable",
          recoverability: "preserved-for-recovery",
        },
      };
    },
  });
  const execution = await harness.subject.execute({
    consumerRoot: "C:\\disposable\\consumer",
    profilePath: "profile.yaml",
    intent: {},
    dryRun: false,
  });

  assert.equal(execution.envelope.outcome, "recovery-required");
  assert.deepEqual(execution.envelope.diagnostics.at(-1)?.remediation, {
    commandId: "docs.doctor",
    args: { consumerRoot: "C:/disposable/consumer" },
  });
  await assertSchema(
    "document-command-envelope/v2",
    execution.envelope,
    "manual-recovery-remediation",
  );
});

test("recovery context preserves a literal POSIX backslash as filename data", async () => {
  const consumerRoot = "/disposable/consumer\\literal";
  const harness = newHarness({
    async inspect() {
      return {
        schemaVersion: 1,
        state: "recoverable",
        operationKind: "document-authoring",
        format: "document-authoring-envelope-v3",
        foundationVersion: "0.16.0",
        foundationBuildIdentity: digest,
        recovery: {
          commandId: "docs-recover",
          exactFoundationVersion: "0.16.0",
          exactFoundationBuildIdentity: digest,
        },
        diagnostics: [],
      };
    },
  });
  const execution = await harness.subject.execute({
    consumerRoot,
    profilePath: "profile.yaml",
    intent: {},
    dryRun: false,
  });

  assert.equal(
    execution.envelope.diagnostics[0]?.remediation?.args.consumerRoot,
    consumerRoot,
  );
});

test("docs recover is a no-op when idle and refuses manual evidence", async () => {
  let recoverCalls = 0;
  const idle = await new RunDocumentRecover({
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async recover() { recoverCalls += 1; return successfulReceipt; }
  }).execute({ consumerRoot: "/fixture" });
  assert.equal(idle.envelope.result.transactionState, "no-pending-transaction");
  assert.equal(idle.envelope.result.writeState, "unchanged");
  assert.equal(idle.envelope.result.recoveryRequired, false);
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
  assert.equal(manual.envelope.result.writeState, "unknown");
  assert.equal(manual.envelope.result.recoveryRequired, true);
  assert.equal(manual.envelope.result.recoveryCommand, undefined);
  assert.equal(recoverCalls, 0);
});

test("docs recover projects committed and unresolved receipts without guessing", async () => {
  const recoverable = {
    schemaVersion: 1, state: "recoverable", operationKind: "document-authoring",
    format: "document-authoring-envelope-v3", foundationVersion: "0.16.0",
    foundationBuildIdentity: digest,
    recovery: { commandId: "docs-recover", exactFoundationVersion: "0.16.0", exactFoundationBuildIdentity: digest },
    diagnostics: []
  };
  const applied = await new RunDocumentRecover({
    async inspect() { return recoverable; },
    async recover() {
      return {
        ...successfulReceipt,
        commit: { publication: "published" }
      };
    }
  }).execute({ consumerRoot: "/fixture" });
  assert.equal(applied.envelope.result.transactionState, "recovered");
  assert.equal(applied.envelope.result.writeState, "committed");
  assert.equal(applied.envelope.result.recoveryRequired, false);

  const pending = await new RunDocumentRecover({
    async inspect() { return recoverable; },
    async recover() {
      return {
        outcome: "recovery-required",
        receiptDigest: digest,
        diagnostics: [],
        commit: { publication: "unknown" }
      };
    }
  }).execute({ consumerRoot: "/fixture" });
  assert.equal(pending.envelope.result.transactionState, "recovery-required");
  assert.equal(pending.envelope.result.writeState, "unknown");
  assert.equal(pending.envelope.result.recoveryRequired, true);
});

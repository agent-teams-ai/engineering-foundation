import assert from "node:assert/strict";
import test from "node:test";

function success(result) { return { exitCode: 0, envelope: { result } }; }

function scenarioFixture(overrides = {}) {
  const calls = [];
  let observed = 0;
  const preview = { documentPath: "docs/new.md", planDigest: "plan", reachability: { state: "not-required" } };
  const request = { fixtureRoot: "source", scenario: { find: { query: {}, expectedIds: ["ADR-1"] }, newDocument: { intent: {} } }, signal: new AbortController().signal };
  const workspace = {
    async resolveRoot(root) { calls.push(["resolve", root]); return root; },
    async snapshot() { return "source-digest"; },
    async createDisposable() { return {
      consumerRoot: "disposable",
      async copyFrom(root) { calls.push(["copy", root]); },
      async dispose() { calls.push(["dispose"]); }
    }; },
    async bootstrapInstallation(root, rewrite) { calls.push(["bootstrap", root, rewrite]); },
    async fileSnapshot() { return new Map(observed++ < 2 ? [] : [["file:docs/new.md", "digest"]]); },
    async parentState() { return "directory"; },
    async applyReachability(root, action) { calls.push(["reachability", root, action]); },
    ...overrides
  };
  const protocol = {
    async infoV2(input) { calls.push(["info", input]); return success({ projectId: "fixture" }); },
    async findV2(input) { calls.push(["find", input]); return success({ documents: [{ id: "ADR-1" }] }); },
    async newDocumentV2(input) { calls.push(["preview", input]); return success(preview); },
    async checkV2(input) { calls.push(["check", input]); return success({}); },
    async doctorV2(input) { calls.push(["doctor", input]); return success({}); }
  };
  const dependencies = { workspace, createProtocol: () => protocol, async interruptAndRecover(input) {
    calls.push(["recover", input]);
    return { receiptDigest: "receipt", receipt: { commit: { publication: "published", state: "committed" }, outcome: "applied" } };
  } };
  return { calls, dependencies, protocol, request, preview };
}

test("application qualification orchestrates injected observations without constructing IO", async () => {
  const { createQualificationRunner } = await import("../dist/features/qualification/application/run-qualification.js");
  const fixture = scenarioFixture();
  const run = createQualificationRunner(fixture.dependencies);
  assert.deepEqual(fixture.calls, []);
  const receipt = await run(fixture.request);
  assert.deepEqual(receipt, { appliedDocumentPath: "docs/new.md", projectId: "fixture", schemaVersion: 1,
    checks: ["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"] });
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.checks));
  assert.deepEqual(fixture.calls.map(([name]) => name), ["resolve", "copy", "bootstrap", "info", "find", "preview", "recover", "reachability", "check", "doctor", "dispose"]);
  for (const [name, input] of fixture.calls) {
    if (["info", "find", "preview", "check", "doctor"].includes(name)) {assert.equal(input.signal, fixture.request.signal);}
  }
  assert.equal(fixture.calls.find(([name]) => name === "reachability")[2], fixture.preview.reachability);
});

test("application qualification preserves failure and cancellation identity and always disposes", async () => {
  const { createQualificationRunner } = await import("../dist/features/qualification/application/run-qualification.js");
  const failure = new Error("port failure");
  const fixture = scenarioFixture();
  fixture.protocol.newDocumentV2 = async () => { throw failure; };
  await assert.rejects(createQualificationRunner(fixture.dependencies)(fixture.request), (error) => error === failure);
  assert.equal(fixture.calls.at(-1)[0], "dispose");
  const cancelled = scenarioFixture();
  const controller = new AbortController();
  controller.abort(failure);
  await assert.rejects(createQualificationRunner(cancelled.dependencies)({ ...cancelled.request, signal: controller.signal }), (error) => error === failure);
  assert.deepEqual(cancelled.calls.map(([name]) => name), ["resolve", "dispose"]);
});

test("application qualification rejects preview effects and unrelated apply writes", async () => {
  const { createQualificationRunner } = await import("../dist/features/qualification/application/run-qualification.js");
  for (const [boundary, message] of [[1, /Preview mutated/u], [2, /Apply changed paths outside/u]]) {
    let observation = 0;
    const fixture = scenarioFixture({ async fileSnapshot() {
      return new Map(observation++ < boundary ? [] : [["file:unrelated.md", "mutation"]]);
    } });
    await assert.rejects(createQualificationRunner(fixture.dependencies)(fixture.request), message);
    assert.equal(fixture.calls.at(-1)[0], "dispose");
    assert.equal(fixture.calls.some(([name]) => name === "check"), false);
  }
});

test("application recovery uses the exact composed plan, profile, signal and receipt", async () => {
  const { createInterruptAndRecover } = await import("../dist/features/qualification/application/recovery.js");
  const controller = new AbortController();
  const plan = { destination: "docs/new.md", planDigest: "plan", privateEvidence: { identity: "retained" } };
  const receipt = { transactionState: "recovered", writeState: "committed", receiptDigest: "receipt", receipt: { outcome: "applied", commit: { state: "committed", publication: "published" } } };
  const calls = [];
  const dependencies = {
    async readProfile(input) { calls.push(["profile", input]); return { foundationProfile: { path: "foundation.yaml" } }; },
    async planDocument(input) { calls.push(["plan", input]); return plan; },
    async crashAtDurablePublishing(...args) { calls.push(["crash", ...args]); }
  };
  const protocol = {
    async doctorV2(input) { calls.push(["doctor", input]); return { exitCode: 1, envelope: { outcome: "recovery-required", result: { transaction: { state: "recoverable" } } } }; },
    async recoverV2(input) { calls.push(["recover", input]); return { exitCode: 0, envelope: { result: receipt } }; }
  };
  const input = { consumerRoot: "disposable", profilePath: "docs.yaml", base: { intent: {}, signal: controller.signal, related: ["ADR-1"], blockedBy: ["ADR-2"] },
    previewResult: { documentPath: "docs/new.md", planDigest: "plan", reachability: {} }, protocol };
  const recovered = await createInterruptAndRecover(dependencies)(input);
  assert.equal(recovered, receipt);
  assert.deepEqual(calls.map(([name]) => name), ["profile", "plan", "crash", "doctor", "recover"]);
  assert.equal(calls[1][1].profilePath, "foundation.yaml");
  assert.deepEqual(calls[1][1].intent.related, ["ADR-1", "ADR-2"]);
  assert.deepEqual(calls[1][1].intent.additionalMetadata, { blocked_by: ["ADR-2"] });
  assert.equal(calls[2][2], plan);
  assert.equal(calls[2][3], controller.signal);
  for (const [name, value] of calls) {if (name !== "crash") {assert.equal(value.signal, controller.signal);}}
  calls.length = 0;
  await assert.rejects(createInterruptAndRecover(dependencies)({ ...input, previewResult: { ...input.previewResult, planDigest: "other" } }), /crash Plan differs/u);
  assert.deepEqual(calls.map(([name]) => name), ["profile", "plan"]);
});

test("public qualification retains the released names and production helper identity", async () => {
  const api = await import("../dist/qualification/index.js");
  assert.deepEqual(Object.keys(api).toSorted(), ["applyReachability", "bootstrapQualificationInstallation", "changedPaths", "digest", "documentResult", "fileSnapshot", "interruptAndRecover", "isQualificationEvidenceExcludedPath", "portableQualificationSkill", "qualificationEvidencePolicy", "readContainedBoundedFile", "requireSuccess", "runDocsProtocolQualification", "signalOption", "snapshot"].toSorted());
  const runtime = await import("../dist/features/qualification/application/runtime.js");
  const evidence = await import("../dist/features/qualification/adapters/filesystem-evidence.js");
  assert.equal(api.documentResult, runtime.documentResult);
  assert.equal(api.snapshot, evidence.snapshot);
});

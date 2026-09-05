import assert from "node:assert/strict";
import test from "node:test";
import { createDocsProtocolQualificationV2 } from "../dist/qualification/application-api.js";

function success(result) { return { exitCode: 0, envelope: { result } }; }

function qualificationFixture() {
  const calls = [];
  const signal = new AbortController().signal;
  const scenarios = ["adr", "note"].map((type) => ({ id: type, type, intent: { id: type, title: type, owner: "fixture", summary: "fixture" },
    expected: { documentPath: `docs/${type}.md`, reachability: { state: "not-required" }, goldenFile: `${type}.golden`, goldenDigest: `sha256:${type}`, metadataStorage: "frontmatter" } }));
  const integration = { schemaVersion: 2, profilePath: "docs.yaml", skillPath: "skill.md", governedDocsRoots: ["docs"],
    qualification: { contractPath: "architecture/foundation/docs-protocol-qualification.json", gateCommand: "pnpm docs:protocol:check" },
    cohort: { id: "fixture", packages: { docsProtocol: { version: "1.0.0" }, engineeringFoundation: { version: "2.0.0" } } } };
  const contract = { schemaVersion: 2, scenarios };
  const protocol = {
    async infoV2(input) { calls.push(["info", input]); return success({ projectId: "fixture", types: scenarios.map(({ type }) => ({ type })) }); },
    async findV2(input) { calls.push(["find", input]); return success({ documents: [] }); },
    async checkV2(input) { calls.push(["check", input]); return success({}); },
    async doctorV2(input) { calls.push(["doctor", input]); return success({ environment: { installedFoundationBuildIdentity: "sha256:foundation", installedFoundationVersion: "2.0.0" } }); },
    async recoverV2(input) { calls.push(["recover", input]); return success({ transactionState: "no-pending-transaction" }); },
    async newDocumentV2(input) {
      calls.push([input.apply ? "apply" : "preview", input]);
      const type = input.intent.type;
      return success({ documentPath: `docs/${type}.md`, planDigest: `plan:${type}`, reachability: { state: "not-required" }, compiled: { document: { content: `${type} bytes\n`, digest: `sha256:${type}` } } });
    }
  };
  const environment = {
    protocol,
    async resolveRoot(root) { return root; },
    async readIntegration() { return { value: integration, evidence: { path: "integration.json", digest: "sha256:integration" } }; },
    async readContract() { return { contract, evidence: { path: integration.qualification.contractPath, digest: "sha256:contract" } }; },
    async snapshot() { return "sha256:source"; },
    async fileSnapshot() { return new Map(); },
    async createDisposable() { return { consumerRoot: "disposable", async copyFrom() { calls.push(["copy"]); }, async dispose() { calls.push(["dispose"]); } }; },
    async bootstrapInstallation(root, rewrite) { calls.push(["bootstrap", root, rewrite]); return { docsVersion: "1.0.0", authoringVersion: "1.0.0", mutationVersion: "1.0.0", adapterVersion: "1.0.0" }; },
    async overlaySkill() {},
    async readScripts() { return { "docs:protocol:check": "never execute this fixture string" }; },
    async readGolden(root, path) { return `${path.split(".")[0]} bytes\n`; },
    async readDocument(root, path) { return `${path.slice(5, -3)} bytes\n`; },
    async interruptAndRecover(input) { calls.push(["crash-recover", input]); },
    async applyReachability() { calls.push(["reachability"]); },
    async collectEvidence() { return { executingModule: new Uint8Array([1, 2]), lockfileDigest: "sha256:lock", packageManifestDigest: "sha256:manifest",
      profile: { path: "docs.yaml", digest: "sha256:profile" }, skill: { path: "skill.md", digest: "sha256:skill" } }; }
  };
  const integrationApi = { async assertProfile(value) { assert.equal(value, integration); }, async check() { calls.push(["integration-check"]); return { outcome: "current" }; } };
  return { calls, environment, contract, integrationApi, request: { consumerRoot: "source", localDevelopment: true, signal } };
}

test("managed application coordinates every scenario with exact portable bytes and local receipt policy", async () => {
  const fixture = qualificationFixture();
  const run = createDocsProtocolQualificationV2(fixture);
  assert.deepEqual(fixture.calls, []);
  const receipt = await run(fixture.request);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.evidenceClass, "local-development");
  assert.equal(receipt.cohortAdmissible, false);
  assert.deepEqual(receipt.scenarios, [
    { id: "adr", type: "adr", documentPath: "docs/adr.md", outputDigest: "sha256:adr" },
    { id: "note", type: "note", documentPath: "docs/note.md", outputDigest: "sha256:note" }
  ]);
  assert.deepEqual(receipt.checks, ["info", "find", "check", "doctor", "recover", "preview", "apply", "path", "reachability", "golden", "source-unchanged"]);
  assert.ok(Object.isFrozen(receipt));
  assert.ok(receipt.scenarios.every(Object.isFrozen));
  assert.deepEqual(fixture.calls.filter(([name]) => ["preview", "apply", "crash-recover"].includes(name)).map(([name]) => name), ["preview", "crash-recover", "preview", "apply"]);
  for (const [name, input] of fixture.calls) {if (["info", "find", "check", "doctor", "recover", "preview", "apply"].includes(name)) {assert.equal(input.signal, fixture.request.signal);}}
  assert.equal(fixture.calls.at(-1)[0], "dispose");
  assert.equal(receipt.receiptDigest, (await run(fixture.request)).receiptDigest);
});

test("managed application fails closed on golden bytes, source mutation and incomplete type coverage", async () => {
  for (const failure of ["golden", "source", "coverage", "apply"]) {
    const fixture = qualificationFixture();
    let message;
    if (failure === "golden") { fixture.environment.readGolden = async () => "different bytes"; message = /golden file mismatch/u; }
    if (failure === "source") { let n = 0; fixture.environment.snapshot = async () => `sha256:${n++}`; message = /modified its source consumer/u; }
    if (failure === "coverage") { fixture.contract.scenarios = fixture.contract.scenarios.slice(0, 1); message = /cover every authorable type exactly once/u; }
    if (failure === "apply") {
      const original = fixture.environment.protocol.newDocumentV2;
      fixture.environment.protocol.newDocumentV2 = async (input) => {
        const value = await original(input);
        return input.apply ? { ...value, envelope: { result: { ...value.envelope.result, planDigest: "other" } } } : value;
      };
      message = /preview\/apply parity mismatch/u;
    }
    await assert.rejects(createDocsProtocolQualificationV2(fixture)(fixture.request), message);
    assert.equal(fixture.calls.at(-1)[0], "dispose");
  }
});

test("managed application preserves adapter errors, pre-cancellation and released admission", async () => {
  const fixture = qualificationFixture();
  const error = new Error("exact adapter failure");
  fixture.environment.readGolden = async () => { throw error; };
  await assert.rejects(createDocsProtocolQualificationV2(fixture)(fixture.request), (actual) => actual === error);
  assert.equal(fixture.calls.at(-1)[0], "dispose");
  const cancelled = qualificationFixture();
  const controller = new AbortController();
  controller.abort(error);
  await assert.rejects(createDocsProtocolQualificationV2(cancelled)({ ...cancelled.request, signal: controller.signal }), (actual) => actual === error);
  assert.deepEqual(cancelled.calls, [["dispose"]]);
  const released = qualificationFixture();
  released.integrationApi.check = async () => ({ outcome: "blocked", issues: ["fixture refusal"] });
  await assert.rejects(createDocsProtocolQualificationV2(released)({ ...released.request, localDevelopment: false }), /current exact managed integration.*fixture refusal/u);
  assert.deepEqual(released.calls, []);
});

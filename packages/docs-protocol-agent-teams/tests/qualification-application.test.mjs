import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    async collectEvidence() { return { executingModule: new Uint8Array([1, 2]), executingApplication: new Uint8Array([3, 4]), lockfileDigest: "sha256:lock", packageManifestDigest: "sha256:manifest",
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
  for (const failure of ["golden", "golden-digest", "source", "coverage", "apply"]) {
    const fixture = qualificationFixture();
    let message;
    if (failure === "golden") { fixture.environment.readGolden = async () => "different bytes"; message = /golden file mismatch/u; }
    if (failure === "golden-digest") { fixture.contract.scenarios[0].expected.goldenDigest = "sha256:wrong"; message = /golden digest mismatch/u; }
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

test("managed application retains exact released version admission", async () => {
  const fixture = qualificationFixture();
  const request = { ...fixture.request, localDevelopment: false };
  const receipt = await createDocsProtocolQualificationV2(fixture)(request);
  assert.equal(receipt.evidenceClass, "released-cohort");
  assert.equal(receipt.cohortAdmissible, true);
  assert.ok(fixture.calls.some(([name]) => name === "integration-check"));
  fixture.environment.bootstrapInstallation = async () => ({ docsVersion: "other" });
  await assert.rejects(createDocsProtocolQualificationV2(fixture)(request), /execution identity does not match/u);
  assert.equal(fixture.calls.at(-1)[0], "dispose");
});

const applicationArtifact = "dist/qualification/application/use-cases/qualify-v2.js";
const adapterArtifact = "dist/qualification/adapters/outbound/node-managed-qualification.js";

async function executingFixture(t, mutate = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "managed-qualification-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  // Copy exact emitted artifacts before any mutation or import; installed bytes stay untouched.
  await cp(join(packageRoot, "dist"), join(root, "dist"), { recursive: true, errorOnExist: true, force: false });
  await cp(join(packageRoot, "package.json"), join(root, "package.json"));
  await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const artifact of [applicationArtifact, adapterArtifact]) {
    const original = await readFile(join(packageRoot, artifact));
    assert.deepEqual(await readFile(join(root, artifact)), original);
    t.after(async () => assert.deepEqual(await readFile(join(packageRoot, artifact)), original));
  }
  await mutate(root);
  const { createDocsProtocolQualificationV2: create } = await import(pathToFileURL(join(root, applicationArtifact)).href);
  const { createNodeManagedQualificationEnvironment } = await import(pathToFileURL(join(root, adapterArtifact)).href);
  const fixture = qualificationFixture();
  const consumerRoot = join(root, "consumer");
  await mkdir(consumerRoot);
  for (const path of ["docs.yaml", "skill.md", "package.json", "pnpm-lock.yaml"]) {
    await writeFile(join(consumerRoot, path), `${path}\n`);
  }
  const disposable = await fixture.environment.createDisposable();
  fixture.environment.createDisposable = async () => ({ ...disposable, consumerRoot });
  fixture.environment.collectEvidence = createNodeManagedQualificationEnvironment(fixture.environment.interruptAndRecover).collectEvidence;
  return { root, ...fixture, run: () => create(fixture)(fixture.request) };
}

test("production evidence binds relocated policy and Node adapter bytes in disposable emitted copies", async (t) => {
  const original = await executingFixture(t);
  const unchanged = await executingFixture(t);
  const policyChanged = await executingFixture(t, async (root) => {
    const path = join(root, applicationArtifact);
    const source = await readFile(path, "utf8");
    const rejection = "throw new Error(`Qualification scenario ${scenario.id} golden digest mismatch.`);";
    assert.equal(source.split(rejection).length, 2);
    await writeFile(path, source.replace(rejection, "void 0;"));
  });
  const adapterChanged = await executingFixture(t, async (root) => {
    const path = join(root, adapterArtifact);
    await writeFile(path, `${await readFile(path, "utf8")}\n// Disposable adapter byte change.\n`);
  });
  const baseline = await original.run();
  assert.deepEqual(await original.run(), baseline);
  assert.deepEqual(await unchanged.run(), baseline);
  for (const fixture of [policyChanged, adapterChanged]) {
    const receipt = await fixture.run();
    assert.notEqual(receipt.evidence.executingDocsProtocol.buildDigest, baseline.evidence.executingDocsProtocol.buildDigest);
    assert.notEqual(receipt.receiptDigest, baseline.receiptDigest);
    assert.deepEqual(receipt.scenarios, baseline.scenarios);
  }
  original.contract.scenarios[0].expected.goldenDigest = "sha256:wrong";
  policyChanged.contract.scenarios[0].expected.goldenDigest = "sha256:wrong";
  await assert.rejects(original.run(), /golden digest mismatch/u);
  const admittedByChangedPolicy = await policyChanged.run();
  assert.notEqual(admittedByChangedPolicy.evidence.executingDocsProtocol.buildDigest, baseline.evidence.executingDocsProtocol.buildDigest);
});

test("production evidence fails closed when either required emitted artifact is missing", async (t) => {
  for (const artifact of [applicationArtifact, adapterArtifact]) {
    const fixture = await executingFixture(t);
    // Modules are loaded first so the actual evidence collector observes the missing file.
    await rm(join(fixture.root, artifact));
    await assert.rejects(fixture.run(), { code: "ENOENT", path: join(fixture.root, artifact) });
    assert.equal(fixture.calls.at(-1)[0], "dispose");
  }
});

test("managed execution identity distinguishes artifact boundaries and names", async () => {
  const identities = [];
  for (const [executingModule, executingApplication] of [[[1], [2, 3]], [[1, 2], [3]], [[2, 3], [1]]]) {
    const fixture = qualificationFixture();
    const evidence = await fixture.environment.collectEvidence();
    fixture.environment.collectEvidence = async () => ({ ...evidence,
      executingModule: new Uint8Array(executingModule), executingApplication: new Uint8Array(executingApplication) });
    identities.push((await createDocsProtocolQualificationV2(fixture)(fixture.request)).evidence.executingDocsProtocol.buildDigest);
  }
  assert.equal(new Set(identities).size, identities.length);
});

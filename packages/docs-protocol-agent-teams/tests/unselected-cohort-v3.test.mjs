import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { loadUnselectedCohortV3, parseRecord } from "../dist/consumer-integration/adapters/unselected-cohort-v3-loader.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root));
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const source = await read("../../architecture/foundation/docs-protocol-current-policy-v2.json");
const asset = await read("assets/runtime-policy.v1.json");
const projected = JSON.parse(asset);
const cohortSchema = JSON.parse(await read("schemas/qualified-docs-cohort/v3.schema.json"));
const assetSchema = JSON.parse(await read("schemas/managed-runtime-policy/v1.schema.json"));
const oldSchema = JSON.parse(await read("schemas/qualified-docs-cohort/v2.schema.json"));
const policySchema = JSON.parse(await read("../../architecture/contracts/docs-protocol-current-policy/v2.schema.json"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validatePolicy = ajv.compile(policySchema);
const validateAsset = ajv.compile(assetSchema);
const validateCohort = ajv.compile(cohortSchema);
const validateOld = ajv.compile(oldSchema);
const digest = (digit) => `sha256:${digit.repeat(64)}`;
const pkg = { version: "1.0.0", integrity: `sha512-${"A".repeat(86)}==` };
const valid = () => ({
  schemaVersion: 3, cohortId: "candidate-v3", channel: "rc", recordDigest: digest("1"),
  qualificationEventDigest: digest("2"), eligibleAfter: "2026-09-28T00:00:00Z",
  upgradeFrom: ["prior-v2"], rollbackTo: ["prior-v2"],
  packages: { repositoryMutation: pkg, documentAuthoring: pkg, docsProtocol: pkg,
    docsProtocolAgentTeams: pkg, engineeringFoundation: pkg },
  workflow: { repository: "agent-teams-ai/.github", path: ".github/workflows/docs-protocol-check.yml",
    revision: "a".repeat(40), blobSha: "b".repeat(40) },
  assets: { skillDigest: digest("3"), callerWorkflowDigest: digest("4"),
    assetCatalogDigest: digest("5"), transitionCatalogDigest: digest("6") },
  schemas: { consumerIntegration: 4, managedState: 3, qualificationReceipt: 1, docsProtocol: 1 },
  candidateDigest: digest("9"),
  runtime: {
    policy: { id: "agent-teams.docs-protocol-current-policy", version: "2.0.0", digest: hash(source) },
    selectedLane: "node-26-managed-qualified", node: ">=26.0.0 <27", pnpm: ">=11.17.0 <12",
    qualificationRuntime: { nodeVersion: "26.10.0", pnpmVersion: "11.20.0", platform: "linux", architecture: "x64" },
    runtimeClosure: { domain: "agent-teams.docs-runtime-closure/v2", digest: digest("7") },
  },
  lifecycleState: "QUALIFIED", canaryRepositoryIds: ["1"],
});

test("v2 policy is a closed unselected successor and packed projection binds its exact bytes", async () => {
  const policy = JSON.parse(source);
  assert.equal(hash(await read("../../architecture/foundation/docs-protocol-current-policy.json")),
    "sha256:b446075de07aa2655561e0cba7d15ed13cc2062b91303e961f06b6afddb18efc");
  assert.equal(hash(await read("../../architecture/contracts/docs-protocol-current-policy/v1.schema.json")),
    "sha256:3067433b3e5b8f964049f5b83dc29ac06bb32d6c88ac3d39eee3ad7769bd6f70");
  assert.equal(hash(source), "sha256:4db0b267a08c75d22eeddde9bdf69b70c0da0b165bb13e18d6e685df4a5cd801");
  assert.equal(hash(asset), "sha256:d8da2a5234309f52801b39649695a80cb8875df999027b8d6367eebff8bdb87b");
  assert.equal(validatePolicy(policy), true, JSON.stringify(validatePolicy.errors));
  for (const path of [policy.contracts.protocol.schemaPath, policy.contracts.profile.currentSchemaPath,
    policy.contracts.portableCommandEnvelope.currentSchemaPath]) {
    assert.ok((await read(`../../${path}`)).byteLength > 0, path);
  }
  const portableManifest = JSON.parse(await read("../docs-protocol/package.json"));
  assert.ok(portableManifest.exports["./qualification"], "declared portable qualification entrypoint");
  const qualification = await import("@agent-teams/docs-protocol/qualification");
  assert.equal(typeof qualification[policy.contracts.portableQualificationReceipt.export], "function");
  assert.equal(projected.sourceDigest, hash(source));
  assert.equal(validateAsset(projected), true, JSON.stringify(validateAsset.errors));
  assert.deepEqual(assetSchema.const, projected);
  assert.deepEqual(projected.productionDefault, policy.runtime.productionDefault);
  assert.deepEqual(projected.compatibilityLane, policy.runtime.compatibilityLane);
  assert.deepEqual(projected.managedCandidate, policy.managedCandidate);
  assert.deepEqual(projected.managedRuntime, policy.managedRuntime);
  assert.equal(policy.runtime.productionDefault.default, true);
  assert.equal(policy.runtime.compatibilityLane.cutoverAuthorized, false);
  assert.equal(policy.history.preservedSchemas.length, 15);
  const protectedHistory = new Map(policy.history.preservedSchemas.map((item) => [item.path, item.sha256]));
  assert.equal(protectedHistory.get("packages/docs-protocol-agent-teams/schemas/docs-consumer-integration-profile/v3.schema.json"),
    "sha256:c70a0c05aeb576c4301a2bea5514ec2f0dc81fd5d77a84d0e8721578fcec19fe");
  assert.equal(protectedHistory.get("packages/docs-protocol-agent-teams/schemas/docs-consumer-managed-state/v2.schema.json"),
    "sha256:b1537e65d602d090e998244fc0d20cbad472b1b8a18528f6afdb214e744b5d4b");
  assert.equal(protectedHistory.get("packages/docs-protocol-agent-teams/schemas/docs-protocol-qualification-receipt/v3.schema.json"),
    "sha256:cc8e8fb12c461bbce4922dec9996a42a79bbab010395c4f60821a6d588e738fe");
  for (const item of policy.history.preservedSchemas) {
    assert.equal(hash(await read(`../../${item.path}`)), item.sha256, item.path);
  }
  for (const change of [
    (p) => { p.managedCandidate.selected = true; },
    (p) => { p.runtime.productionDefault.nodeMajor = 26; },
    (p) => { p.managedCandidate.qualificationReceipt = 4; },
  ]) { const bad = structuredClone(policy); change(bad); assert.equal(validatePolicy(bad), false); }
  const extraAsset = { ...projected, selected: true };
  assert.equal(validateAsset(extraAsset), false);
  const alteredLane = structuredClone(projected);
  alteredLane.managedRuntime.lanes["node-26-managed-qualified"].qualificationRuntime.nodeVersion = "26.11.0";
  assert.equal(validateAsset(alteredLane), false);
});

test("packed policy asset has an exact public artifact disposition", async () => {
  const manifest = JSON.parse(await read("package.json"));
  const config = parseYaml((await read("../../architecture/foundation/public-api-compatibility.yaml")).toString("utf8"));
  const managed = config.packages.find((entry) => entry.packageName === manifest.name);
  assert.equal(manifest.exports["./assets/runtime-policy.v1.json"], "./assets/runtime-policy.v1.json");
  assert.deepEqual(managed.nonTypeExports, [
    { exportPath: "./assets/runtime-policy.v1.json", kind: "data" },
    { exportPath: "./package.json", kind: "data" },
    { exportPath: "./schemas/*", kind: "wildcard" },
  ]);
});

test("policy and schema admission rejects decoded duplicate keys before validation", async () => {
  for (const [name, bytes, nested] of [
    ["policy", asset, '"managedRuntime": {'],
    ["schema", await read("schemas/managed-runtime-policy/v1.schema.json"), '"const": {'],
  ]) {
    const sourceText = bytes.toString("utf8");
    for (const [scope, candidate] of [
      ["top-level", sourceText.replace("{", '{"x":0,"x":1,')],
      ["nested", sourceText.replace(nested, `${nested}"x":0,"x":1,`)],
      ["escaped", sourceText.replace("{", '{"x":0,"\\u0078":1,')],
    ]) {
      assert.notEqual(candidate, sourceText, `${name} ${scope} fixture must change`);
      assert.throws(() => parseRecord(candidate), { name: "StrictJsonError", failure: "duplicate-key" }, `${name} ${scope}`);
    }
  }
});

test("unselected v3 validates closed tuple, lanes, identity and packed policy references", async () => {
  assert.equal(validateCohort(valid()), true, JSON.stringify(validateCohort.errors));
  assert.equal(validateOld(valid()), false, "old reader must reject v3");
  assert.equal((await loadUnselectedCohortV3(JSON.stringify(valid()))).schemaVersion, 3);
  const defaultLane = valid();
  defaultLane.runtime.selectedLane = "node-24-production-default";
  defaultLane.runtime.node = ">=24.18.0 <25";
  defaultLane.runtime.qualificationRuntime.nodeVersion = "24.21.0";
  assert.equal((await loadUnselectedCohortV3(JSON.stringify(defaultLane))).runtime.selectedLane,
    "node-24-production-default");
  defaultLane.runtime.qualificationRuntime.nodeVersion = "26.10.0";
  await assert.rejects(loadUnselectedCohortV3(JSON.stringify(defaultLane)));
  for (const change of [
    (c) => { c.schemas.managedState = 2; },
    (c) => { delete c.schemas.qualificationReceipt; },
    (c) => { c.runtime.node = ">=24.18.0 <25"; },
    (c) => { c.runtime.qualificationRuntime.nodeVersion = "24.21.0"; },
    (c) => { delete c.runtime.policy; },
    (c) => { c.candidateDigest = digest("0"); },
    (c) => { c.packages.docsProtocolMcp = pkg; },
    (c) => { c.recordDigest = digest("0"); },
    (c) => { c.runtime.policy.digest = digest("8"); },
    (c) => { c.runtime.policy.digest = hash(asset); },
    (c) => { c.upgradeFrom = []; },
    (c) => { c.upgradeFrom = [c.cohortId]; },
    (c) => { c.rollbackTo = [c.cohortId]; },
    (c) => { c.rollbackTo = ["unrelated-v1"]; },
    (c) => { c.rollbackTo = ["prior-v2", "prior-v2"]; },
    (c) => { c.upgradeFrom = ["prior-v2", "prior-v2"]; },
  ]) { const bad = valid(); change(bad); await assert.rejects(loadUnselectedCohortV3(JSON.stringify(bad))); }
  const duplicate = JSON.stringify(valid()).replace('"schemaVersion":3', '"schemaVersion":3,"schemaVersion":3');
  await assert.rejects(loadUnselectedCohortV3(duplicate));
  const nestedDuplicate = JSON.stringify(valid()).replace('"selectedLane":"node-26-managed-qualified"',
    '"selectedLane":"node-26-managed-qualified","selectedLane":"node-24-production-default"');
  await assert.rejects(loadUnselectedCohortV3(nestedDuplicate));
  const decodedDuplicate = JSON.stringify(valid()).replace('"selectedLane":"node-26-managed-qualified"',
    '"selectedLane":"node-26-managed-qualified","selected\\u004cane":"node-24-production-default"');
  await assert.rejects(loadUnselectedCohortV3(decodedDuplicate));
  await assert.rejects(loadUnselectedCohortV3(`${JSON.stringify(valid())}${" ".repeat(1024 * 1024)}`));
});

test("packed Cohort v3 accepts real UTC seconds and rejects impossible calendar dates", async () => {
  for (const eligibleAfter of ["2024-02-29T23:59:59Z", "2026-02-28T00:00:00Z", "2026-12-31T23:59:59Z"]) {
    const candidate = valid(); candidate.eligibleAfter = eligibleAfter;
    assert.equal((await loadUnselectedCohortV3(JSON.stringify(candidate))).eligibleAfter, eligibleAfter);
  }
  for (const eligibleAfter of ["2026-02-30T00:00:00Z", "2026-99-99T99:99:99Z", "2025-02-29T00:00:00Z"]) {
    const candidate = valid(); candidate.eligibleAfter = eligibleAfter;
    await assert.rejects(loadUnselectedCohortV3(JSON.stringify(candidate)), /eligibleAfter/);
  }
});

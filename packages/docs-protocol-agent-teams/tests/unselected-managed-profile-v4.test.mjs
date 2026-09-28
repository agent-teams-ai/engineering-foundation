import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadUnselectedManagedProfileV4 } from "../dist/consumer-integration/adapters/unselected-managed-profile-v4-loader.js";
import { loadUnselectedCohortV3 } from "../dist/consumer-integration/adapters/unselected-cohort-v3-loader.js";
import { projectManagedSuccessorState } from "../dist/consumer-integration/application-api.js";
import { assertConsumerIntegrationProfileSchema } from "../dist/consumer-integration/adapters/consumer-integration-schema-validator.js";

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const digest = (digit) => `sha256:${digit.repeat(64)}`;
const policy = await read("../assets/runtime-policy.v1.json");
const packageCoordinate = { version: "1.0.0", integrity: `sha512-${"A".repeat(86)}==` };
const cohort = () => ({
  schemaVersion: 3, cohortId: "candidate-v3", channel: "rc", recordDigest: digest("1"),
  qualificationEventDigest: digest("2"), eligibleAfter: "2026-09-28T00:00:00Z",
  upgradeFrom: ["prior-v2"], rollbackTo: ["prior-v2"], candidateDigest: digest("9"),
  packages: Object.fromEntries(["repositoryMutation", "documentAuthoring", "docsProtocol",
    "docsProtocolAgentTeams", "engineeringFoundation"].map((key) => [key, packageCoordinate])),
  workflow: { repository: "agent-teams-ai/.github", path: ".github/workflows/docs-protocol-check.yml",
    revision: "a".repeat(40), blobSha: "b".repeat(40) },
  assets: { skillDigest: digest("3"), callerWorkflowDigest: digest("4"),
    assetCatalogDigest: digest("5"), transitionCatalogDigest: digest("6") },
  schemas: { consumerIntegration: 4, managedState: 3, docsProtocol: 1, qualificationReceipt: 1 },
  runtime: { policy: { id: policy.policyId, version: policy.policyVersion, digest: policy.sourceDigest },
    selectedLane: "node-26-managed-qualified", node: ">=26.0.0 <27", pnpm: policy.managedRuntime.pnpm,
    qualificationRuntime: policy.managedRuntime.lanes["node-26-managed-qualified"].qualificationRuntime,
    runtimeClosure: { domain: "agent-teams.docs-runtime-closure/v2", digest: digest("7") } },
});
const profile = () => ({ schemaVersion: 4,
  repository: { provider: "github", id: "123", nameWithOwner: "example/docs" },
  integrationRoot: ".", packageManager: "pnpm", profilePath: "architecture/foundation/docs-protocol.yaml",
  skillPath: ".agents/skills/docs-authoring/SKILL.md", callerWorkflowPath: ".github/workflows/docs-protocol.yml",
  managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
  qualification: { contractPath: "architecture/foundation/docs-protocol-qualification.json",
    gateCommand: "pnpm docs:protocol:check" }, governedDocsRoots: ["docs"], cohort: cohort() });
const fullCohort = (binding) => ({ ...binding, lifecycleState: "QUALIFIED", canaryRepositoryIds: ["1"] });
const assets = () => ({ ...cohort().assets, agentsRouteDigest: digest("8"), docsScriptsDigest: digest("a") });
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("packed successor refs compile and profile4 remains unselected", async () => {
  const manifest = await read("../package.json");
  assert.equal(manifest.exports["./schemas/*"], "./schemas/*");
  assert.ok(manifest.files.includes("schemas"));
  const ajv = new Ajv2020({ strict: true });
  ajv.addSchema(await read("../schemas/qualified-docs-cohort/v3.schema.json"));
  const validateProfile = ajv.compile(await read("../schemas/docs-consumer-integration-profile/v4.schema.json"));
  const validateState = ajv.compile(await read("../schemas/docs-consumer-managed-state/v3.schema.json"));
  const selected = await loadUnselectedManagedProfileV4(JSON.stringify(profile()));
  assert.equal(validateProfile(selected), true);
  await assert.rejects(assertConsumerIntegrationProfileSchema(selected), /exactly 1, 2, or 3/);
  const state = JSON.parse(projectManagedSuccessorState(selected, assets()));
  assert.equal(validateState(state), true, JSON.stringify(validateState.errors));
  const { stateDigest, ...body } = state;
  assert.equal(stateDigest, "sha256:0dd58e6b7fd348a85db0fb5d6de319b086cc5f7006a0ea3c966accf5af5e2c22");
  assert.equal(stateDigest, sha(canonical({ domain: "agent-teams.docs-protocol.managed-state/v3", body })));
  assert.equal(state.cohortAuthority.candidateDigest, selected.cohort.candidateDigest);
  assert.deepEqual(state.workflow, selected.cohort.workflow);
  for (const change of [
    (s) => { s.schemas.managedState = 2; },
    (s) => { s.cohortAuthority.candidateDigest = digest("0"); },
    (s) => { s.extra = true; },
  ]) { const invalid = structuredClone(state); change(invalid); assert.equal(validateState(invalid), false); }
  const old = new Ajv2020({ strict: true });
  old.addSchema(await read("../schemas/qualified-docs-cohort/v2.schema.json"));
  assert.equal(old.compile(await read("../schemas/docs-consumer-managed-state/v2.schema.json"))(state), false);
});

test("profile and state refuse mixed generations, policy swaps and asset mutation", async () => {
  for (const mutate of [
    (p) => { p.schemaVersion = 3; }, (p) => { p.cohort.schemas.managedState = 2; },
    (p) => { p.cohort.runtime.selectedLane = "node-24-production-default"; },
    (p) => { p.cohort.runtime.policy.digest = digest("f"); },
    (p) => { p.cohort.packages.docsProtocolMcp = packageCoordinate; },
    (p) => { p.cohort.candidateDigest = digest("0"); },
    (p) => { p.cohort.rollbackTo = ["unrelated"]; },
  ]) { const invalid = profile(); mutate(invalid); await assert.rejects(loadUnselectedManagedProfileV4(JSON.stringify(invalid))); }
  const valid = await loadUnselectedManagedProfileV4(JSON.stringify(profile()));
  const badAssets = assets(); badAssets.skillDigest = digest("f");
  assert.throws(() => projectManagedSuccessorState(valid, badAssets));
  const nestedDuplicate = JSON.stringify(profile()).replace('"selectedLane":"node-26-managed-qualified"',
    '"selectedLane":"node-26-managed-qualified","selected\\u004cane":"node-24-production-default"');
  await assert.rejects(loadUnselectedManagedProfileV4(nestedDuplicate));
  await assert.rejects(loadUnselectedManagedProfileV4("x".repeat(1024 * 1024 + 1)), /bounded input size/);
});

test("all successor package coordinates require exact semantic versions through loaders and state refs", async () => {
  const ajv = new Ajv2020({ strict: true });
  ajv.addSchema(await read("../schemas/qualified-docs-cohort/v3.schema.json"));
  const validateCohort = ajv.getSchema("https://agent-teams.ai/schemas/qualified-docs-cohort/v3");
  const validateProfile = ajv.compile(await read("../schemas/docs-consumer-integration-profile/v4.schema.json"));
  const validateState = ajv.compile(await read("../schemas/docs-consumer-managed-state/v3.schema.json"));
  const accepted = ["1.0.0", "1.0.0-rc.1", "1.0.0-rc.1+build.01", "0.0.0+001"];
  const rejected = ["1.0.0-..", "01.0.0", "1.0.0-01", "1.0.0-", "1.0.0+", "1.0.0+bad..id", "1.0.0-rc.01"];
  const keys = Object.keys(cohort().packages);
  for (const version of accepted) {
    const candidate = profile();
    candidate.cohort.packages.docsProtocol = { ...packageCoordinate, version };
    assert.equal(validateCohort(fullCohort(candidate.cohort)), true, version);
    assert.equal(validateProfile(candidate), true, version);
    assert.equal((await loadUnselectedCohortV3(JSON.stringify(fullCohort(candidate.cohort)))).packages.docsProtocol.version, version);
    const loaded = await loadUnselectedManagedProfileV4(JSON.stringify(candidate));
    assert.equal(validateState(JSON.parse(projectManagedSuccessorState(loaded, assets()))), true, version);
  }
  const base = JSON.parse(projectManagedSuccessorState(await loadUnselectedManagedProfileV4(JSON.stringify(profile())), assets()));
  for (const key of keys) { for (const version of rejected) {
    const candidate = profile();
    candidate.cohort.packages[key] = { ...packageCoordinate, version };
    assert.equal(validateCohort(fullCohort(candidate.cohort)), false, `${key}: ${version}`);
    assert.equal(validateProfile(candidate), false, `${key}: ${version}`);
    await assert.rejects(loadUnselectedCohortV3(JSON.stringify(fullCohort(candidate.cohort))), undefined, `${key}: ${version}`);
    await assert.rejects(loadUnselectedManagedProfileV4(JSON.stringify(candidate)), undefined, `${key}: ${version}`);
    const state = structuredClone(base);
    state.packages[key] = { ...packageCoordinate, version };
    assert.equal(validateState(state), false, `${key}: ${version}`);
  } }
});

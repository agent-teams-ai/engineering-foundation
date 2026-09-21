import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { parse } from "yaml";
import { parseCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/parse-capability-config.js";
import { FilesystemPackageArtifactInventory } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js";
import { AjvJsonSchemaReleaseInspector } from "../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/module.js";
import { projectGrowthPackage } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/project-growth-package.js";
import { growthGroupFingerprint, growthTransitionFingerprint } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js";
import { isGrowthDecision } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-decision.js";
import { publicApiEvidenceAdapters } from "./support/capability-adapters.mjs";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const gitObject = (kind, bytes) => createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest();
const execFileAsync = promisify(execFile);
const gitBytes = async args => Buffer.from((await execFileAsync("git", args, { encoding: "buffer" })).stdout);
const currentSourcePaths = Object.freeze({
  loaderTest: "tests/public-api-configuration.test.mjs",
  packedQualification: "scripts/pack-sdk-growth-test.mjs",
  qualificationPolicy: "architecture/foundation/public-api-compatibility.yaml"
});
const assertSnapshot = async snapshot => {
  const bytes = await readFile(snapshot.path);
  assert.equal(hash(bytes), snapshot.contentDigest);
  assert.equal(gitObject("blob", bytes).toString("hex"), snapshot.blob);
};
const assertCurrentSources = async candidate => {
  assert.deepEqual(Object.keys(candidate.currentSources).toSorted(), Object.keys(currentSourcePaths).toSorted());
  for (const [role, path] of Object.entries(currentSourcePaths)) {
    assert.equal(candidate.currentSources[role].path, path, `${role} must bind ${path}`);
    await assertSnapshot(candidate.currentSources[role]);
  }
};
const assertCurrentCandidateSources = async (candidateBytes, policyEntry) => {
  assert.equal(hash(candidateBytes), policyEntry.evidenceDigest);
  await assertCurrentSources(JSON.parse(candidateBytes));
};
test("release-owned SDK v2 corpus binds exact schema bytes and discriminating fixtures", async () => {
  const corpus = JSON.parse(await readFile("architecture/contracts/sdk-growth-v2/identity.json"));
  assert.equal(corpus.publicContractVersion, "2.0.0");
  assert.equal(corpus.status, "artifact-protected-unreleased");
  assert.equal(hash(await readFile(corpus.schemaPath)), corpus.schemaDigest);
  assert.deepEqual(corpus.fixtures.map(row => row.expectation).toSorted(), ["invalid", "valid"]);
  for (const fixture of corpus.fixtures) {
    const bytes = await readFile(fixture.path);
    assert.equal(hash(bytes), fixture.digest);
    const validate = () => assertSchema("package-public-api-compatibility/v2", JSON.parse(bytes), "sdk-v2-corpus");
    if (fixture.expectation === "valid") { await validate(); }
    else { await assert.rejects(validate()); }
  }
  const valid = JSON.parse(await readFile(corpus.fixtures.find(row => row.expectation === "valid").path));
  valid.sdkGrowth.comparison.released = [{ packageName: "sdk-packed-fixture", kind: "initial-unreleased", trustedHistoryPath: "history.json" }];
  await assertSchema("package-public-api-compatibility/v2", valid, "sdk-v2-initial");
  valid.sdkGrowth.comparison.released[0].observationPath = "release.json";
  await assert.rejects(assertSchema("package-public-api-compatibility/v2", valid, "sdk-v2-mixed"));
});

test("v2 first-surface decision matches the real schema wildcard projection and exact qualification source", async () => {
  const decision = JSON.parse(await readFile("architecture/contracts/sdk-growth-v2/first-surface.json"));
  const retained = JSON.parse(await readFile("architecture/contracts/sdk-growth-v2/first-surface-evidence.json"));
  assert.ok(isGrowthDecision(decision));
  const policies = parseCapabilityConfig(parse(await readFile("architecture/foundation/public-api-compatibility.yaml", "utf8"))).packages;
  const policy = policies.find(row => row.packageName === "@agent-teams/engineering-foundation");
  const manifest = JSON.parse(await readFile(policy.manifestPath));
  const files = publicApiEvidenceAdapters();
  const artifact = (await new FilesystemPackageArtifactInventory(new AjvJsonSchemaReleaseInspector(files.files), files)
    .inspect(process.cwd(), policies)).find(row => row.packageName === policy.packageName);
  const fingerprint = { sha256: value => createHash("sha256").update(value).digest("hex") };
  const unavailable = { status: "unavailable", reasons: ["typed-scope-not-needed-for-schema-member"] };
  const projection = projectGrowthPackage({
    pkg: { name: manifest.name, rootPath: policy.packageRoot, manifestPath: policy.manifestPath, moduleType: manifest.type,
      exportSurface: { explicit: true, entries: Object.entries(manifest.exports).map(([subpath, target]) => ({ subpath, target })) } },
    subject: { policy, packageVersion: manifest.version }, retained: {
      compatibility: { packageName: manifest.name, typed: { kind: "typed", snapshot: unavailable }, artifact: { kind: "artifact", snapshot: unavailable } },
      artifactObservation: { status: "available", value: artifact }
    }
  }, fingerprint);
  const observed = projection.entries.find(row => row.coordinate.exportPath === decision.coordinates[0].exportPath);
  assert.deepEqual(observed.coordinate, decision.coordinates[0]);
  assert.deepEqual(observed.value, retained.transition.after);
  assert.equal(growthTransitionFingerprint(retained.transition, fingerprint), decision.transitions[0]);
  assert.equal(growthGroupFingerprint(decision.transitions, fingerprint), decision.changeFingerprint);
  const candidate = JSON.parse(await readFile("architecture/contracts/sdk-growth-v2/current-candidate-evidence.json"));
  const retainedBinding = candidate.retainedHistory.firstSurfaceEvidence;
  assert.equal(retainedBinding.path, "architecture/contracts/sdk-growth-v2/first-surface-evidence.json");
  assert.equal(retainedBinding.source.path, retained.sourceSnapshot.path);
  assert.equal(retainedBinding.source.blob, "4ddf1d89e6d672588eed0d458f751b3a837dc443");
  assert.equal(hash(await readFile(retainedBinding.path)), retainedBinding.contentDigest);
  const source = await gitBytes(["cat-file", "blob", retained.sourceSnapshot.blob]);
  assert.equal(hash(source), retained.sourceSnapshot.contentDigest);
  assert.equal(gitObject("blob", source).toString("hex"), retained.sourceSnapshot.blob);
  assert.equal(retainedBinding.source.contentDigest, retained.sourceSnapshot.contentDigest);
  assert.equal(retainedBinding.source.blob, retained.sourceSnapshot.blob);
  assert.equal(retainedBinding.source.tree, retained.sourceSnapshot.tree);
  assert.equal(retained.sourceSnapshot.contentDigest, decision.consumerEvidenceRefs[0].source.contentDigest);
  const blob = gitObject("blob", source);
  const subtree = gitObject("tree", Buffer.concat([Buffer.from("100644 pack-sdk-growth-test.mjs\0"), blob]));
  const tree = gitObject("tree", Buffer.concat([Buffer.from("40000 scripts\0"), subtree])).toString("hex");
  assert.equal(tree, decision.consumerEvidenceRefs[0].source.tree);
  assert.equal(retained.sourceSnapshot.tree, tree);
  assert.equal(decision.consumerEvidenceRefs[0].source.commit, null);
  await assertCurrentSources(candidate);
});

test("v2 release-owned family baseline and real loader consumer evidence pass the schema-release capability", async () => {
  const configPath = "architecture/foundation/sdk-growth-json-schema-releases.json";
  const policy = JSON.parse(await readFile(configPath));
  const baseline = JSON.parse(await readFile(policy.releasedBaselinePath));
  const historicalBytes = await readFile("architecture/contracts/sdk-growth-v2/consumer-evidence.json");
  const historical = JSON.parse(historicalBytes);
  const candidateBytes = await readFile("architecture/contracts/sdk-growth-v2/current-candidate-evidence.json");
  const candidate = JSON.parse(candidateBytes);
  assert.equal(hash(candidateBytes), policy.currentConsumerEvidence[0].evidenceDigest);
  assert.equal(hash(historicalBytes), candidate.retainedHistory.consumerEvidence.contentDigest);
  const retainedSource = candidate.retainedHistory.consumerEvidence.source;
  assert.equal(candidate.retainedHistory.consumerEvidence.path, "architecture/contracts/sdk-growth-v2/consumer-evidence.json");
  assert.equal(retainedSource.revision, "8fd2dd69494e1307a71842514f46cee13cf6e0f6");
  const historicalSource = await gitBytes(["show", `${retainedSource.revision}:${retainedSource.path}`]);
  assert.equal(hash(historicalSource), historical.sourceDigest);
  assert.equal(hash(historicalSource), retainedSource.contentDigest);
  assert.equal(gitObject("blob", historicalSource).toString("hex"), retainedSource.blob);
  assert.equal(historical.sourcePath, retainedSource.path);
  assert.equal(historical.sourceDigest, retainedSource.contentDigest);
  await assertCurrentSources(candidate);
  assert.deepEqual(policy.currentConsumerEvidence[0], {
    consumerId: candidate.consumerId, consumerVersion: candidate.consumerVersion,
    contractId: candidate.contractId, contractVersion: candidate.contractVersion,
    schemaSetDigest: candidate.schemaSetDigest, fixtureCorpusDigest: candidate.fixtureCorpusDigest,
    evidenceDigest: hash(candidateBytes), outcome: candidate.outcome
  });
  assert.deepEqual(
    baseline.supportedConsumers.map(({ evidenceDigest: _evidenceDigest, ...row }) => row),
    policy.currentConsumerEvidence.map(({ evidenceDigest: _evidenceDigest, ...row }) => row)
  );
  const { createJsonSchemaReleaseCapability } = await import("../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/module.js");
  const capability = createJsonSchemaReleaseCapability({ assertSchema });
  const report = await capability.run({ consumerRoot: process.cwd(), configPath });
  assert.equal(report.outcome, "passed", JSON.stringify(report));
  const { loadCapabilityConfig } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js");
  for (const fixture of policy.fixtures) {
    const config = JSON.parse(await readFile(fixture.path));
    const load = () => loadCapabilityConfig({ readYaml: async (_root, path) => path === config.governanceConfigPath
      ? parse(await readFile("tests/fixtures/governance-architecture-decisions/valid/governance-architecture-decisions.yaml", "utf8")) : config, assertSchema }, process.cwd(), "config.yaml");
    if (fixture.expectation === "valid") {
      const parsed = await load();
      assert.equal(parsed.schemaVersion, 2);
      assert.deepEqual(Object.keys(parsed.sdkGrowth).toSorted(), ["comparison", "contractRevision", "decisionsPath", "policyVersion", "reportPath"]);
    } else { await assert.rejects(load(), error => error.name === "CapabilityInputError", fixture.id); }
  }
});

test("current SDK v2 source roles reject valid tuple substitution after refreshing the candidate digest", async () => {
  const candidatePath = "architecture/contracts/sdk-growth-v2/current-candidate-evidence.json";
  const candidate = JSON.parse(await readFile(candidatePath));
  const policy = JSON.parse(await readFile("architecture/foundation/sdk-growth-json-schema-releases.json"));
  const roles = Object.keys(currentSourcePaths);
  for (const targetRole of roles) {
    for (const sourceRole of roles.filter(role => role !== targetRole)) {
      const substituted = structuredClone(candidate);
      substituted.currentSources[targetRole] = structuredClone(candidate.currentSources[sourceRole]);
      const substitutedBytes = Buffer.from(`${JSON.stringify(substituted, null, 2)}\n`);
      const refreshedPolicyEntry = {
        ...policy.currentConsumerEvidence[0],
        evidenceDigest: hash(substitutedBytes)
      };
      await assert.rejects(
        assertCurrentCandidateSources(substitutedBytes, refreshedPolicyEntry),
        error => error instanceof assert.AssertionError
          && error.message.includes(`${targetRole} must bind ${currentSourcePaths[targetRole]}`),
        `${sourceRole} tuple substituted for ${targetRole}`
      );
    }
  }
});

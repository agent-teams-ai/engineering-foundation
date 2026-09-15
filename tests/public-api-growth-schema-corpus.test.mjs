import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
  const source = await readFile(retained.sourceSnapshot.path);
  assert.equal(hash(source), decision.consumerEvidenceRefs[0].source.contentDigest);
  const blob = gitObject("blob", source);
  const subtree = gitObject("tree", Buffer.concat([Buffer.from("100644 pack-sdk-growth-test.mjs\0"), blob]));
  const tree = gitObject("tree", Buffer.concat([Buffer.from("40000 scripts\0"), subtree])).toString("hex");
  assert.equal(tree, decision.consumerEvidenceRefs[0].source.tree);
  assert.equal(retained.sourceSnapshot.tree, tree);
  assert.equal(decision.consumerEvidenceRefs[0].source.commit, null);
});

test("v2 release-owned family baseline and real loader consumer evidence pass the schema-release capability", async () => {
  const configPath = "architecture/foundation/sdk-growth-json-schema-releases.json";
  const policy = JSON.parse(await readFile(configPath));
  const baseline = JSON.parse(await readFile(policy.releasedBaselinePath));
  const receiptBytes = await readFile("architecture/contracts/sdk-growth-v2/consumer-evidence.json");
  const receipt = JSON.parse(receiptBytes);
  assert.equal(hash(receiptBytes), policy.currentConsumerEvidence[0].evidenceDigest);
  assert.equal(hash(await readFile(receipt.sourcePath)), receipt.sourceDigest);
  assert.deepEqual(baseline.supportedConsumers, policy.currentConsumerEvidence);
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

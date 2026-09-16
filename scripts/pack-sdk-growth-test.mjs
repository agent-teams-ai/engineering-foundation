import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalDigest, runCommand, runNpmCommand, writeJson } from "./pack-test-support.mjs";
import { assertPackedSdkGrowthAuthorityExecution } from "./packed-sdk-growth-authority-fixture.mjs";

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const packageName = "sdk-packed-fixture";
const schemaId = "https://schemas.agent-teams.ai/engineering-foundation/package-public-api-compatibility/v2";

async function check(cli, root, expected = 2, publicationRequired = true) {
  let output;
  try { output = { ...await runCommand(process.execPath, [cli, "check", "--consumer", root, "--format", "json"], root), code: 0 }; }
  catch (error) { if (typeof error.code !== "number") { throw error; } output = error; }
  assert.equal(output.code, expected, output.stdout || output.message);
  const aggregate = JSON.parse(output.stdout);
  if (publicationRequired) {
    const capability = aggregate.capabilities[0];
    assert.equal(capability.capabilityConfigSchemaVersion, 2);
    assert.equal(capability.problem?.code, "SDK_GROWTH_EVIDENCE_INCOMPLETE", output.stdout);
    const publication = capability.diagnostics.find(row => row.ruleId === "package.public-api-compatibility.sdk-growth-report");
    assert.ok(publication, "Check must reach report publication");
    const bytes = await readFile(join(root, "reports/sdk.json"));
    const report = JSON.parse(bytes);
    assert.equal(report.contractRevision, "foundation:sdk-growth:c0:5");
    assert.equal(report.policyVersion, "foundation:sdk-growth:policy:1");
    assert.equal(report.verdict, "incomplete");
    assert.equal(report.releaseEligible, false);
    assert.deepEqual(report.transitionReceipts, []);
    assert.deepEqual(report.phases.map(row => row.name), ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"]);
    assert.equal(report.candidate.status, "available");
    assert.ok(publication.evidence.some(row => row.kind === "sdk-growth-report-digest" && row.value === sha256(bytes)));
  }
  return aggregate;
}

async function buildFixture(root, compiler, reversed) {
  const source = "export function stable(value: string): string { return value; }\n";
  await mkdir(join(root, "pkg/src"), { recursive: true });
  await mkdir(join(root, "reports"), { recursive: true }); await mkdir(join(root, "evidence"), { recursive: true });
  await mkdir(join(root, ".changeset"), { recursive: true });
  await writeJson(join(root, "package.json"), { name: "sdk-fixture-root", private: true });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - pkg\n");
  await writeFile(join(root, "pkg/src/index.ts"), source);
  const types = "./dist/index.d.ts", runtime = "./dist/index.js";
  await writeJson(join(root, "pkg/package.json"), { name: packageName, version: "1.0.0", type: "module", license: "MIT",
    exports: { ".": reversed ? { import: runtime, types } : { types, import: runtime }, "./data/*": "./dist/data/*" }, files: ["dist"] });
  await writeJson(join(root, "pkg/tsconfig.json"), { compilerOptions: { module: "NodeNext", target: "ES2024", declaration: true,
    outDir: "dist", rootDir: "src", types: [] }, include: ["src"] });
  await runCommand(process.execPath, [compiler, "--project", "pkg/tsconfig.json"], root);
  await mkdir(join(root, "pkg/dist/data"), { recursive: true });
  await writeFile(join(root, "pkg/dist/data/fixture.txt"), "disposable packed artifact\n");
  const packed = await runNpmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", root], join(root, "pkg"));
  const artifactDigest = sha256(await readFile(join(root, JSON.parse(packed.stdout)[0].filename)));
  await writeFile(join(root, "foundation.config.yaml"), "schemaVersion: 1\nproject:\n  id: sdk-packed-fixture\ncapabilities:\n  package.public-api-compatibility:\n    configPath: policy.yaml\n");
  await cp(new URL("../tests/fixtures/governance-architecture-decisions/valid/", import.meta.url), root, { recursive: true });
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const config = JSON.parse(await readFile(new URL("../architecture/contracts/sdk-growth-v2/valid.json", import.meta.url)));
  config.governanceConfigPath = "governance-architecture-decisions.yaml";
  config.packages[0].nonTypeExports = [{ exportPath: "./data/*", kind: "wildcard" }];
  await writeJson(join(root, "policy.yaml"), config);
  await writeJson(join(root, "evidence/decisions.json"), []);
  await checkpoint(root);
  return { config, artifactDigest };
}

async function checkpoint(root) {
  await runCommand("git", ["init", "--quiet"], root);
  await runCommand("git", ["add", "pkg"], root);
  await runCommand("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], root);
}

/** Exercises installed public schemas and the manifest-selected binary against
 * separately built and packed disposable packages. Disposable Git/lock inputs
 * deliberately confer no authority; no consumer activation is claimed. */
export async function testPackedSdkGrowth({ consumerRoot, artifact }) {
  const require = createRequire(join(consumerRoot, "package.json"));
  const installedManifest = require.resolve("@agent-teams/engineering-foundation/package.json");
  const manifest = JSON.parse(await readFile(installedManifest));
  const cli = join(dirname(installedManifest), manifest.bin["agent-teams-foundation"]);
  const schema = JSON.parse(await readFile(require.resolve("@agent-teams/engineering-foundation/schemas/package-public-api-compatibility/v2.schema.json")));
  assert.equal(schema.$id, schemaId);
  assert.equal(schema.additionalProperties, false);
  const compilerManifestPath = require.resolve("typescript/package.json");
  const compilerManifest = JSON.parse(await readFile(compilerManifestPath));
  const compiler = join(dirname(compilerManifestPath), compilerManifest.bin.tsc);
  const parent = await mkdtemp(join(dirname(consumerRoot), "sdk-growth-packed-"));
  // Repository identity is derived from the actual Git root. Observe successive
  // committed checkpoints in one disposable repository, retaining both packs.
  const candidate = join(await realpath(parent), "repository");
  const { config, artifactDigest: baseArtifactDigest } = await buildFixture(candidate, compiler, false);
  await cp(join(candidate, `${packageName}-1.0.0.tgz`), join(parent, "base-fixture.tgz"));
  await check(cli, candidate);
  const baseReport = JSON.parse(await readFile(join(candidate, "reports/sdk.json")));
  assert.equal(baseReport.candidate.status, "available");
  // The frozen report contains references, not retained S1 aggregates. Prepare
  // disposable historical evidence using the installed private observer, then
  // qualify all candidate behavior through the installed public CLI.
  const base = await observeHistoricalFixture(installedManifest, candidate, config, baseReport);
  assert.equal(base.surface.status, "available");
  const { artifactDigest: candidateArtifactDigest } = await buildFixture(candidate, compiler, true);
  await cp(join(candidate, `${packageName}-1.0.0.tgz`), join(parent, "candidate-fixture.tgz"));
  await writeJson(join(candidate, "evidence/base.json"), base.surface.value);
  const snapshots = base.compatibilitySnapshots.find(row => row.packageName === packageName);
  assert.equal(snapshots.typed.snapshot.status, "available");
  assert.equal(snapshots.artifact.snapshot.status, "available");
  // Persist the original v1 facts in the baseline reader's canonical item order.
  const releasedArtifact = structuredClone(snapshots.artifact.snapshot.value);
  for (const entry of releasedArtifact.entrypoints) {
    entry.items.sort((left, right) => left.canonicalReference < right.canonicalReference ? -1 : left.canonicalReference > right.canonicalReference ? 1 : 0);
  }
  await writeJson(join(candidate, "evidence/released.json"), { typed: snapshots.typed.snapshot.value, artifact: releasedArtifact });
  async function execute(decisions, expected = 2) {
    await writeJson(join(candidate, "evidence/decisions.json"), decisions);
    await writeJson(join(candidate, "policy.yaml"), config);
    const aggregate = await check(cli, candidate, expected);
    const bytes = await readFile(join(candidate, "reports/sdk.json"));
    return { aggregate, bytes, report: JSON.parse(bytes) };
  }
  const missing = await execute([]);
  assert.ok(missing.aggregate.capabilities[0].diagnostics.some(row => row.ruleId.endsWith("growth-transition-unadmitted")));
  const transitions = missing.report.trustedBaseComparison.findings;
  assert.ok(transitions.length > 0, "Condition order must retain a concrete transition");
  const fingerprints = transitions.map(row => row.fingerprint).toSorted();
  const decision = { contractRevision: "foundation:sdk-growth:c0:5", decisionId: "SDK-PACKED-1", ownerRef: "fixture/sdk-owner", stability: "development",
    transitions: fingerprints, coordinates: transitions.map(row => row.coordinate),
    changeFingerprint: canonicalDigest({ domain: "foundation:sdk-growth:group:1", policyVersion: "foundation:sdk-growth:policy:1", transitions: fingerprints }),
    consumerEvidenceRefs: [{ useCase: "Packed condition-order qualification", repository: missing.report.repository,
      source: { tree: missing.report.candidate.value.sourceTree, contentDigest: missing.report.candidate.value.topologyDigest, commit: null }, artifactDigest: missing.report.candidate.value.artifactDigests[0] }],
    exposureRationale: "Observe ordered package resolution", compatibilityRationale: "Preserve original typed contract", lifecycle: { kind: "ordinary" } };
  const matched = await execute([decision]);
  assert.equal(matched.report.verdict, "incomplete");
  assert.equal(matched.report.authority.status, "unverified");
  assert.equal(matched.report.phases.find(row => row.name === "released").status, "unavailable");
  assert.equal(matched.report.releasedComparison.status, "incomplete");
  assert.ok(!matched.aggregate.capabilities[0].diagnostics.some(row => row.ruleId.includes("breaking")));
  assert.ok(matched.aggregate.capabilities[0].diagnostics.some(row => row.ruleId.endsWith("growth-owner-evidence-unavailable")));
  assert.ok(!matched.aggregate.capabilities[0].diagnostics.some(row => ["growth-transition-unadmitted", "growth-decision-malformed", "growth-decision-fingerprint-mismatch"].some(code => row.ruleId.endsWith(code))));
  await assertPackedSdkGrowthAuthorityExecution({ installedConsumerRoot: consumerRoot, repositoryRoot: candidate,
    config, matchedReport: matched.report, trustedBase: base.surface.value, baseReference: baseReport.candidate.value,
    releasedTyped: snapshots.typed.snapshot.value, releasedArtifact, decision, packageName });
  assert.deepEqual((await execute([decision])).bytes, matched.bytes);
  const malformed = await execute([{ ...decision, ownerRef: "" }]);
  assert.ok(malformed.aggregate.capabilities[0].diagnostics.some(row => row.ruleId.endsWith("growth-decision-malformed")));
  const overlap = await execute([decision, { ...decision, decisionId: "SDK-PACKED-2" }]);
  assert.ok(overlap.aggregate.capabilities[0].diagnostics.some(row => row.ruleId.endsWith("growth-decision-overlap")));
  const reordered = await execute([{ ...decision, decisionId: "SDK-PACKED-2" }, decision]);
  assert.deepEqual(reordered.bytes, overlap.bytes);
  await writeFile(join(candidate, "pkg/src/index.ts"), "export function stable(value: number): string { return String(value); }\n");
  await runCommand(process.execPath, [compiler, "--project", "pkg/tsconfig.json"], candidate);
  await runNpmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", candidate], join(candidate, "pkg"));
  await checkpoint(candidate);
  const broken = await execute([]);
  assert.notDeepEqual(broken.bytes, matched.bytes);
  assert.equal(broken.report.verdict, "incomplete");
  // Root metadata and missing released aggregates keep the overall phase unavailable;
  // the original typed comparator must still expose the concrete breaking change.
  assert.equal(broken.report.phases.find(row => row.name === "released").status, "unavailable");
  assert.ok(broken.aggregate.capabilities[0].diagnostics.some(row => row.ruleId.includes("breaking")));
  await writeJson(join(candidate, "evidence/decisions.json"), [{ authority: { status: "verified" } }]);
  const forged = await check(cli, candidate, 2, false);
  assert.equal(forged.capabilities[0].problem.code, "PUBLIC_API_COMPATIBILITY_CONFIG_INVALID");
  assert.deepEqual(await readFile(join(candidate, "reports/sdk.json")), broken.bytes);
  // The command assertions above use only the public binary. These separately
  // labelled packed-adapter tests exercise deterministic IO barriers privately.
  const writerTests = (await readFile(new URL("../tests/public-api-growth-report-writer.test.mjs", import.meta.url), "utf8"))
    .replaceAll("../packages/engineering-foundation/dist/", new URL("./dist/", pathToFileURL(installedManifest)).href);
  const packedWriterTest = join(parent, "packed-writer.test.mjs");
  await writeFile(packedWriterTest, writerTests);
  await runCommand(process.execPath, ["--test", packedWriterTest], parent);
  const receipt = { outcome: "passed", artifactDigest: artifact.sha256, sourceIdentity: "synthetic-unverified",
    fixtureArtifacts: { base: baseArtifactDigest, candidate: candidateArtifactDigest },
    cases: ["public-schema", "publication-digest", "changed-sequential-update", "private-historical-observation", "missing", "matched-incomplete-2",
      "authority-completed-incomplete-check", "authority-rejected-promotion", "serialized-authority-transport", "malformed", "overlap", "determinism",
      "compatibility", "forged-authority", "packed-private-writer-races-and-cancellation"],
    writerTestDigest: sha256(writerTests), matchedReportDigest: sha256(matched.bytes), compatibilityReportDigest: sha256(broken.bytes) };
  await writeJson(join(parent, "qualification.json"), receipt);
  return receipt;
}

// Private fixture preparation only; the required report remains a projection.
async function observeHistoricalFixture(installedManifest, root, config, report) {
  const load = path => import(new URL(`./dist/${path}.js`, pathToFileURL(installedManifest)));
  const owner = "capabilities/public-api-compatibility";
  const { createGrowthObservation } = await load(`${owner}/application/use-cases/observe-sdk-growth`);
  const { growthObservationReference } = await load(`${owner}/application/policies/normalize-growth-observation`);
  const { createPublicApiExtractor, createPackageArtifactInventory } = await load(`${owner}/module`);
  const { createWorkspaceGrowthReader } = await load(`${owner}/adapters/outbound/filesystem/workspace-growth-reader`);
  const { createWorkspaceInventoryReader } = await load("workspace-inventory/module");
  const { AjvJsonSchemaReleaseInspector } = await load("capabilities/contract-json-schema-releases/module");
  const { readContainedRegularFile } = await load("source-inventory/node");
  const fingerprint = { sha256: value => createHash("sha256").update(value).digest("hex") };
  const { surfaceDigest: _surfaceDigest, ...identity } = report.candidate.value;
  const observation = await createGrowthObservation({ consumerRoot: root, workspaceManifestPath: "pnpm-workspace.yaml",
    subjects: config.packages.map(policy => ({ policy, packageVersion: "1.0.0" })) }, {
    workspace: createWorkspaceGrowthReader(createWorkspaceInventoryReader()), typed: createPublicApiExtractor(),
    artifact: createPackageArtifactInventory(new AjvJsonSchemaReleaseInspector({ read: readContainedRegularFile })), fingerprint
  }).observe({ ...identity, repository: report.repository, tool: report.tool }, { throwIfCancelled() {} });
  assert.equal(observation.surface.status, "available");
  assert.deepEqual(growthObservationReference(observation.surface.value, fingerprint), report.candidate.value);
  return observation;
}

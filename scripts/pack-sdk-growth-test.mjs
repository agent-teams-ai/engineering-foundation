import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalDigest, runCommand, runNpmCommand, writeJson } from "./pack-test-support.mjs";
import { assertPackedSdkGrowthAuthorityExecution, observeClosedFixture } from "./packed-sdk-growth-authority-fixture.mjs";

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const packageName = "sdk-packed-fixture";
const schemaId = "https://schemas.agent-teams.ai/engineering-foundation/package-public-api-compatibility/v2";

function fixtureArtifactBaseline(version) {
  return { schemaVersion: 1, packageName, packageVersion: version, status: version === "1.0.0" ? "supported" : "release-candidate",
    wildcardExports: [{ exportPath: "./data/*", targetPattern: "dist/data/*",
      members: [...(version === "1.1.0" ? ["dist/data/extra.txt"] : []), "dist/data/fixture.txt"] }], jsonSchemas: [] };
}

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
  await mkdir(join(root, "architecture"), { recursive: true });
  const rootClassification = { schemaVersion: "foundation:sdk-growth:metadata-root:1", kind: "non-release-metadata-root",
    packageName: "sdk-fixture-root", rootPath: ".", manifestPath: "package.json", decisionId: "ROOT-1",
    ownerRef: "fixture/sdk-owner", releaseHistory: "none" };
  await writeFile(join(root, "architecture/metadata-root.json"), JSON.stringify(Object.fromEntries(Object.entries(rootClassification).toSorted(([a], [b]) => a < b ? -1 : 1))));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - pkg\n");
  await writeFile(join(root, "pkg/src/index.ts"), source);
  const types = "./dist/index.d.ts", runtime = "./dist/index.js";
  await writeJson(join(root, "pkg/package.json"), { name: packageName, version: "1.0.0", type: "module", license: "MIT",
    exports: { ".": reversed ? { import: runtime, types } : { types, import: runtime }, "./data/*": "./dist/data/*" }, files: ["dist"] });
  await writeJson(join(root, "pkg/tsconfig.json"), { compilerOptions: { module: "NodeNext", target: "ES2024", lib: ["ES5"], declaration: true,
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

async function addFixtureReleaseSurface(root, compiler) {
  await writeFile(join(root, "pkg/src/index.ts"), "export function stable(value: string): string { return value; }\n"
    + "export function added(value: string): string { return value; }\n");
  await runCommand(process.execPath, [compiler, "--project", "pkg/tsconfig.json"], root);
  await writeFile(join(root, "pkg/dist/data/extra.txt"), "additional disposable artifact\n");
  await writeFile(join(root, ".changeset/fixture-minor.md"), `---\n"${packageName}": minor\n---\n\nAdd a typed function and data member.\n`);
}

/** Authoritative installed vertical slice. Preparation observes real source and
 * packs real packages; only the installed public verifier admits and promotes.
 * It avoids unrelated CLI capability startup without changing any deadline. */
export async function testPackedSdkGrowthAuthority({ consumerRoot, artifact }) {
  const require = createRequire(join(consumerRoot, "package.json"));
  const installedManifest = require.resolve("@agent-teams/engineering-foundation/package.json");
  const compilerManifestPath = require.resolve("typescript/package.json");
  const compilerManifest = JSON.parse(await readFile(compilerManifestPath));
  const compiler = join(dirname(compilerManifestPath), compilerManifest.bin.tsc);
  const parent = await mkdtemp(join(dirname(consumerRoot), "sdk-authority-packed-"));
  const root = join(await realpath(parent), "repository");
  const { config } = await buildFixture(root, compiler, false);
  const base = await observeHistoricalFixture(installedManifest, root, config);
  const owner = "capabilities/public-api-compatibility";
  const load = path => import(new URL(`./dist/${path}.js`, pathToFileURL(installedManifest)));
  const { growthObservationReference } = await load(`${owner}/application/policies/normalize-growth-observation`);
  const fingerprint = { sha256: value => createHash("sha256").update(value).digest("hex") };
  const baseReference = growthObservationReference(base.surface.value, fingerprint);
  const releasedArchivePath = join(parent, "base.tgz");
  await cp(join(root, `${packageName}-1.0.0.tgz`), releasedArchivePath);
  const snapshots = base.compatibilitySnapshots.find(row => row.packageName === packageName);
  assert.equal(snapshots.typed.snapshot.status, "available"); assert.equal(snapshots.artifact.snapshot.status, "available");
  const releasedArtifact = structuredClone(snapshots.artifact.snapshot.value);
  for (const entry of releasedArtifact.entrypoints) {
    entry.items = entry.items.toSorted((a, b) => a.canonicalReference < b.canonicalReference ? -1 : a.canonicalReference > b.canonicalReference ? 1 : 0);
  }
  const manifest = JSON.parse(await readFile(join(root, "pkg/package.json")));
  manifest.version = "1.1.0";
  manifest.exports["."] = { import: "./dist/index.js", types: "./dist/index.d.ts" };
  await writeJson(join(root, "pkg/package.json"), manifest);
  await addFixtureReleaseSurface(root, compiler);
  await checkpoint(root);
  await runCommand("git", ["checkout", "-b", "changeset-release/main"], root);
  const packed = await runNpmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", parent], join(root, "pkg"));
  const candidate = await observeHistoricalFixture(installedManifest, root, config);
  const candidateSnapshots = candidate.compatibilitySnapshots.find(row => row.packageName === packageName);
  const transitions = await fixtureArchiveTransitions(installedManifest, base.surface.value, candidate.surface.value,
    releasedArchivePath, join(parent, JSON.parse(packed.stdout)[0].filename));
  assert.ok(transitions.length > 0);
  const matchedReport = { repository: candidate.identity.repository, tool: candidate.identity.tool,
    candidate: { status: "available", value: growthObservationReference(candidate.surface.value, fingerprint) } };
  const decision = fixtureDecision(transitions, matchedReport);
  await writeJson(join(root, "evidence/decisions.json"), [decision]);
  await writeJson(join(root, "evidence/base.json"), base.surface.value);
  await writeJson(join(root, "evidence/released.json"), { typed: snapshots.typed.snapshot.value, artifact: releasedArtifact });
  await writeJson(join(root, config.packages[0].releasedBaselinePath), snapshots.typed.snapshot.value);
  await writeJson(join(root, config.packages[0].releasedBaselinePath.replace(/\.json$/u, ".artifacts.json")), fixtureArtifactBaseline("1.0.0"));
  const promotion = await assertPackedSdkGrowthAuthorityExecution({ installedConsumerRoot: consumerRoot, repositoryRoot: root,
    config, matchedReport, trustedBase: base.surface.value, baseReference, releasedTyped: snapshots.typed.snapshot.value,
    releasedArtifact, decision, packageName, positivePromotion: true, candidateVersion: "1.1.0", foundationArchivePath: artifact.archivePath,
    expectedTyped: candidateSnapshots.typed.snapshot.value, expectedArtifact: fixtureArtifactBaseline("1.1.0"),
    releasedArchivePath, candidateArchivePath: join(parent, JSON.parse(packed.stdout)[0].filename), candidateObservation: candidate.surface.value });
  const result = { outcome: "passed", artifactDigest: artifact.sha256, repositoryRoot: root, promotion,
    cases: ["installed-admitted-check", "single-package-archives", "qualified-metadata-root", "promotion-completion-source-race-no-writes", "exact-receipt-plan-and-baseline-bytes"] };
  await writeJson(join(parent, "qualification.json"), result);
  return result;
}

async function checkpoint(root) {
  await runCommand("git", ["init", "--quiet"], root);
  await runCommand("git", ["add", "pkg", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "architecture/metadata-root.json"], root);
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
    entry.items = entry.items.toSorted((left, right) => left.canonicalReference < right.canonicalReference ? -1 : left.canonicalReference > right.canonicalReference ? 1 : 0);
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
  const decision = fixtureDecision(transitions, missing.report);
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
    releasedTyped: snapshots.typed.snapshot.value, releasedArtifact, decision, packageName,
    foundationArchivePath: artifact.archivePath, releasedArchivePath: join(parent, "base-fixture.tgz"),
    candidateArchivePath: join(parent, "candidate-fixture.tgz"),
    candidateObservation: (await observeHistoricalFixture(installedManifest, candidate, config, matched.report)).surface.value });
  const positiveRoot = join(parent, "promotion-repository");
  await cp(candidate, positiveRoot, { recursive: true });
  await check(cli, positiveRoot);
  const positiveBaseReport = JSON.parse(await readFile(join(positiveRoot, "reports/sdk.json")));
  const positiveBase = await observeHistoricalFixture(installedManifest, positiveRoot, config, positiveBaseReport);
  const positiveBaseSnapshots = positiveBase.compatibilitySnapshots.find(row => row.packageName === packageName);
  assert.equal(positiveBaseSnapshots.typed.snapshot.status, "available");
  assert.equal(positiveBaseSnapshots.artifact.snapshot.status, "available");
  const positiveReleasedArtifact = structuredClone(positiveBaseSnapshots.artifact.snapshot.value);
  for (const entry of positiveReleasedArtifact.entrypoints) {
    entry.items = entry.items.toSorted((left, right) => left.canonicalReference < right.canonicalReference ? -1 : left.canonicalReference > right.canonicalReference ? 1 : 0);
  }
  const positiveManifest = JSON.parse(await readFile(join(positiveRoot, "pkg/package.json")));
  positiveManifest.version = "1.1.0";
  await writeJson(join(positiveRoot, "pkg/package.json"), positiveManifest);
  await addFixtureReleaseSurface(positiveRoot, compiler);
  await mkdir(join(positiveRoot, "architecture/public-api"), { recursive: true });
  await writeJson(join(positiveRoot, config.packages[0].releasedBaselinePath), positiveBaseSnapshots.typed.snapshot.value);
  await writeJson(join(positiveRoot, config.packages[0].releasedBaselinePath.replace(/\.json$/u, ".artifacts.json")), fixtureArtifactBaseline("1.0.0"));
  await checkpoint(positiveRoot);
  await runCommand("git", ["checkout", "-b", "changeset-release/main"], positiveRoot);
  const positivePack = await runNpmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", parent], join(positiveRoot, "pkg"));
  await check(cli, positiveRoot);
  const positiveReport = JSON.parse(await readFile(join(positiveRoot, "reports/sdk.json")));
  const positiveObservation = await observeHistoricalFixture(installedManifest, positiveRoot, config, positiveReport);
  const positiveTransitions = await fixtureArchiveTransitions(installedManifest, positiveBase.surface.value, positiveObservation.surface.value,
    join(parent, "candidate-fixture.tgz"), join(parent, JSON.parse(positivePack.stdout)[0].filename));
  const positiveDecision = fixtureDecision(positiveTransitions, positiveReport);
  await writeJson(join(positiveRoot, "evidence/decisions.json"), [positiveDecision]);
  const positiveSnapshots = positiveObservation.compatibilitySnapshots.find(row => row.packageName === packageName);
  const promotion = await assertPackedSdkGrowthAuthorityExecution({ installedConsumerRoot: consumerRoot, repositoryRoot: positiveRoot,
    config, matchedReport: positiveReport, trustedBase: positiveBase.surface.value, baseReference: positiveBaseReport.candidate.value,
    releasedTyped: positiveBaseSnapshots.typed.snapshot.value, releasedArtifact: positiveReleasedArtifact,
    decision: positiveDecision, packageName, positivePromotion: true, candidateVersion: "1.1.0",
    expectedTyped: positiveSnapshots.typed.snapshot.value, expectedArtifact: fixtureArtifactBaseline("1.1.0"),
    foundationArchivePath: artifact.archivePath, releasedArchivePath: join(parent, "candidate-fixture.tgz"),
    candidateArchivePath: join(parent, JSON.parse(positivePack.stdout)[0].filename),
    candidateObservation: positiveObservation.surface.value });
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
    fixtureArtifacts: { base: baseArtifactDigest, candidate: candidateArtifactDigest }, promotion,
    cases: ["public-schema", "publication-digest", "changed-sequential-update", "private-historical-observation", "missing", "matched-incomplete-2",
      "authority-completed-incomplete-check", "authority-rejected-promotion", "authority-admitted-check-and-promotion", "serialized-authority-transport", "authority-v1-rejected", "actual-archive-custody", "malformed", "overlap", "determinism",
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
  let identity;
  if (report === undefined) {
    const { readGrowthInvocation } = await load(`${owner}/adapters/outbound/filesystem/growth-invocation`);
    const inventory = await createWorkspaceGrowthReader(createWorkspaceInventoryReader()).read(root, "pnpm-workspace.yaml");
    identity = await readGrowthInvocation(root, inventory, { files: { read: readContainedRegularFile },
      runGit: async args => { const result = await runCommand("git", args, root); return { exitCode: 0, stdout: result.stdout }; } });
  } else {
    const { surfaceDigest: _surfaceDigest, ...reference } = report.candidate.value;
    identity = { ...reference, repository: report.repository, tool: report.tool };
  }
  const observation = await createGrowthObservation({ consumerRoot: root, workspaceManifestPath: "pnpm-workspace.yaml",
    subjects: await Promise.all(config.packages.map(async policy => ({ policy, packageVersion: JSON.parse(await readFile(join(root, policy.manifestPath))).version }))) }, {
    workspace: createWorkspaceGrowthReader(createWorkspaceInventoryReader()), typed: createPublicApiExtractor(),
    artifact: createPackageArtifactInventory(new AjvJsonSchemaReleaseInspector({ read: readContainedRegularFile })), fingerprint
  }).observe(identity, { throwIfCancelled() {} });
  assert.equal(observation.surface.status, "available");
  if (report !== undefined) { assert.deepEqual(growthObservationReference(observation.surface.value, fingerprint), report.candidate.value); }
  return observation;
}

function fixtureDecision(transitions, report) {
  const fingerprints = transitions.map(row => row.fingerprint).toSorted();
  return { contractRevision: "foundation:sdk-growth:c0:5", decisionId: "SDK-PACKED-1", ownerRef: "fixture/sdk-owner", stability: "development",
    transitions: fingerprints, coordinates: transitions.map(row => row.coordinate),
    changeFingerprint: canonicalDigest({ domain: "foundation:sdk-growth:group:1", policyVersion: "foundation:sdk-growth:policy:1", transitions: fingerprints }),
    consumerEvidenceRefs: [{ useCase: "Packed condition-order qualification", repository: report.repository,
      source: { tree: report.candidate.value.sourceTree, contentDigest: report.candidate.value.topologyDigest, commit: null }, artifactDigest: report.candidate.value.artifactDigests[0] }],
    exposureRationale: "Observe ordered package resolution", compatibilityRationale: "Preserve original typed contract", lifecycle: { kind: "ordinary" } };
}

async function fixtureArchiveTransitions(installedManifest, base, candidate, baseArchive, candidateArchive) {
  const { compareGrowthSurfaces } = await import(new URL("./dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js", pathToFileURL(installedManifest)));
  const select = async (observation, archive) => {
    const observed = await observeClosedFixture(observation, archive);
    return { ...observed, entries: observed.entries.filter(row => row.coordinate.packageName === packageName),
      coverage: observed.coverage.filter(row => row.packageName === packageName) };
  };
  assert.deepEqual(base.entries.filter(row => row.coordinate.packageName !== packageName), candidate.entries.filter(row => row.coordinate.packageName !== packageName));
  const compared = compareGrowthSurfaces({ trustedBefore: { status: "available", value: await select(base, baseArchive) },
    candidateAfter: { status: "available", value: await select(candidate, candidateArchive) } },
  { sha256: value => createHash("sha256").update(value).digest("hex") });
  assert.equal(compared.status, "complete", JSON.stringify(compared));
  return compared.transitions;
}

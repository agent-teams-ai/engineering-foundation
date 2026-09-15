import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalDigest, runCommand, runNpmCommand, writeJson } from "./pack-test-support.mjs";

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const packageName = "sdk-packed-fixture";
const schemaId = "https://schemas.agent-teams.ai/engineering-foundation/package-public-api-compatibility/v2";

async function check(cli, root, expected = 2) {
  let output;
  try { output = { ...await runCommand(process.execPath, [cli, "check", "--consumer", root, "--format", "json"], root), code: 0 }; }
  catch (error) { if (typeof error.code !== "number") { throw error; } output = error; }
  assert.equal(output.code, expected, output.stdout || output.message);
  return JSON.parse(output.stdout);
}

async function buildFixture(root, compiler, reversed, tool) {
  const source = "export function stable(value: string): string { return value; }\n";
  await mkdir(join(root, "pkg/src"), { recursive: true });
  await mkdir(join(root, "reports")); await mkdir(join(root, "evidence"));
  await writeJson(join(root, "package.json"), { name: "sdk-fixture-root", private: true });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - pkg\n");
  await writeFile(join(root, "pkg/src/index.ts"), source);
  const types = "./dist/index.d.ts", runtime = "./dist/index.js";
  await writeJson(join(root, "pkg/package.json"), { name: packageName, version: "1.0.0", type: "module", license: "MIT",
    exports: { ".": reversed ? { import: runtime, types } : { types, import: runtime } }, files: ["dist"] });
  await writeJson(join(root, "pkg/tsconfig.json"), { compilerOptions: { module: "NodeNext", target: "ES2024", declaration: true,
    outDir: "dist", rootDir: "src", types: [] }, include: ["src"] });
  await runCommand(process.execPath, [compiler, "--project", "pkg/tsconfig.json"], root);
  const packed = await runNpmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", root], join(root, "pkg"));
  const artifactDigest = sha256(await readFile(join(root, JSON.parse(packed.stdout)[0].filename)));
  await writeFile(join(root, "foundation.config.yaml"), "schemaVersion: 1\nproject:\n  id: sdk-packed-fixture\ncapabilities:\n  package.public-api-compatibility:\n    configPath: policy.yaml\n");
  const inputDigest = sha256(source);
  const config = { schemaVersion: 2, acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json", changesetDirectory: ".changeset",
    packages: [{ packageName, packageRoot: "pkg", manifestPath: "pkg/package.json", tsconfigPath: "pkg/tsconfig.json",
      releasedBaselinePath: `architecture/public-api/${packageName}.json`, approvedBreakingChanges: [], nonTypeExports: [],
      entrypoints: [{ exportPath: ".", declarationEntryPoint: "pkg/dist/index.d.ts" }] }],
    sdkGrowth: { workspaceManifestPath: "pnpm-workspace.yaml",
      invocation: { repository: "synthetic/packed-sdk", sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40),
        topologyDigest: sha256(await readFile(join(root, "pkg/package.json"))), lockDigest: inputDigest,
        toolchainDigest: sha256(process.version), artifactDigests: [artifactDigest], tool },
      context: { trustedBasePath: "evidence/base.json", decisionsPath: "evidence/decisions.json",
        released: [{ packageName, kind: "released", observationPath: "evidence/released.json" }] },
      report: { path: "reports/sdk.json", expectedPreimage: null } } };
  await writeJson(join(root, "policy.yaml"), config);
  await writeJson(join(root, "evidence/decisions.json"), []);
  return config;
}

/** Exercises installed public schemas and the manifest-selected binary against
 * separately built and packed disposable packages. Synthetic source/lock IDs
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
  const baseRoot = join(await realpath(parent), "base"), candidate = join(await realpath(parent), "candidate");
  const tool = { version: manifest.version, artifactDigest: artifact.sha256, extractorVersion: "7.58.12" };
  await buildFixture(baseRoot, compiler, false, tool);
  const config = await buildFixture(candidate, compiler, true, tool);
  await check(cli, baseRoot);
  const base = JSON.parse(await readFile(join(baseRoot, "reports/sdk.json")));
  assert.equal(base.observation.surface.status, "available");
  await writeJson(join(candidate, "evidence/base.json"), base.observation.surface.value);
  const snapshots = base.observation.compatibilitySnapshots[0];
  assert.equal(snapshots.typed.snapshot.status, "available");
  assert.equal(snapshots.artifact.snapshot.status, "available");
  await writeJson(join(candidate, "evidence/released.json"), { typed: snapshots.typed.snapshot.value, artifact: snapshots.artifact.snapshot.value });
  async function execute(decisions, expected = 2) {
    await writeJson(join(candidate, "evidence/decisions.json"), decisions);
    await writeJson(join(candidate, "policy.yaml"), config);
    const aggregate = await check(cli, candidate, expected);
    const bytes = await readFile(join(candidate, "reports/sdk.json"));
    config.sdkGrowth.report.expectedPreimage = sha256(bytes);
    return { aggregate, bytes, report: JSON.parse(bytes) };
  }
  const missing = await execute([]);
  assert.ok(missing.report.admission.diagnostics.some(row => row.code === "growth-transition-unadmitted"));
  const transitions = missing.report.comparison.findings;
  assert.ok(transitions.length > 0, "Condition order must retain a concrete transition");
  const fingerprints = transitions.map(row => row.fingerprint).toSorted();
  const decision = { contractRevision: "foundation:sdk-growth:c0:5", decisionId: "SDK-PACKED-1", ownerRef: "fixture/sdk-owner", stability: "development",
    transitions: fingerprints, coordinates: transitions.map(row => row.coordinate),
    changeFingerprint: canonicalDigest({ domain: "foundation:sdk-growth:group:1", policyVersion: "foundation:sdk-growth:policy:1", transitions: fingerprints }),
    consumerEvidenceRefs: [{ useCase: "Packed condition-order qualification", repository: "synthetic/packed-sdk",
      source: { tree: "2".repeat(40), contentDigest: config.sdkGrowth.invocation.topologyDigest, commit: null }, artifactDigest: config.sdkGrowth.invocation.artifactDigests[0] }],
    exposureRationale: "Observe ordered package resolution", compatibilityRationale: "Preserve original typed contract", lifecycle: { kind: "ordinary" } };
  const matched = await execute([decision]);
  assert.equal(matched.report.admission.status, "incomplete");
  assert.equal(matched.report.authority.status, "unverified");
  assert.equal(matched.report.compatibility.status, "complete");
  assert.ok(matched.report.admission.diagnostics.some(row => row.code === "growth-owner-evidence-unavailable"));
  assert.ok(!matched.report.admission.diagnostics.some(row => ["growth-transition-unadmitted", "growth-decision-malformed", "growth-decision-fingerprint-mismatch"].includes(row.code)));
  assert.deepEqual((await execute([decision])).bytes, matched.bytes);
  const malformed = await execute([{ ...decision, ownerRef: "" }]);
  assert.ok(malformed.report.admission.diagnostics.some(row => row.code === "growth-decision-malformed"));
  const overlap = await execute([decision, { ...decision, decisionId: "SDK-PACKED-2" }]);
  assert.ok(overlap.report.admission.diagnostics.some(row => row.code === "growth-decision-overlap"));
  const reordered = await execute([{ ...decision, decisionId: "SDK-PACKED-2" }, decision]);
  assert.deepEqual(reordered.bytes, overlap.bytes);
  await writeFile(join(candidate, "pkg/src/index.ts"), "export function stable(value: number): string { return String(value); }\n");
  await runCommand(process.execPath, [compiler, "--project", "pkg/tsconfig.json"], candidate);
  const repacked = await runNpmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", candidate], join(candidate, "pkg"));
  config.sdkGrowth.invocation.artifactDigests = [sha256(await readFile(join(candidate, JSON.parse(repacked.stdout)[0].filename)))];
  const broken = await execute([]);
  assert.equal(broken.report.compatibility.status, "rejected");
  assert.ok(broken.report.compatibility.diagnostics.some(row => row.ruleId.includes("breaking")));
  await writeJson(join(candidate, "evidence/decisions.json"), [{ authority: { status: "verified" } }]);
  await check(cli, candidate);
  assert.deepEqual(await readFile(join(candidate, "reports/sdk.json")), broken.bytes);
  // The command assertions above use only the public binary. These separately
  // labelled packed-adapter tests exercise deterministic IO barriers privately.
  const writerTests = (await readFile(new URL("../tests/public-api-growth-report-writer.test.mjs", import.meta.url), "utf8"))
    .replaceAll("../packages/engineering-foundation/dist/", new URL("./dist/", pathToFileURL(installedManifest)).href);
  const packedWriterTest = join(parent, "packed-writer.test.mjs");
  await writeFile(packedWriterTest, writerTests);
  await runCommand(process.execPath, ["--test", packedWriterTest], parent);
  const receipt = { outcome: "passed", artifactDigest: artifact.sha256, sourceIdentity: "synthetic-unverified",
    cases: ["public-schema", "missing", "matched-incomplete-2", "malformed", "overlap", "determinism", "compatibility", "forged-authority", "packed-private-writer-races-and-cancellation"],
    writerTestDigest: sha256(writerTests), matchedReportDigest: sha256(matched.bytes), compatibilityReportDigest: sha256(broken.bytes) };
  await writeJson(join(parent, "qualification.json"), receipt);
  return receipt;
}

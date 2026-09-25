import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { types } from "node:util";
import { createVerifiedGrowthObservation } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/verified-growth-observation.js";
import { hashGrowthPayload } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js";
import { growthCanonicalJson, growthObservationReference, normalizeGrowthObservation } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import { growthDimensions } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
import { growthAuthorityGrantDigest, validateGrowthAuthorityGrant as validateGrant } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-authority.js";
import { admitSdkGrowth } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/admit-sdk-growth.js";
import { request, grant, initialPackage, fingerprint, invocation, d, custody, sealEvidence, observation, authoritySnapshot, now } from "./support/public-api-growth-authority-fixture.mjs";
const validateGrowthAuthorityGrant = (value, req, hasher, clock) => validateGrant(value, req, hasher, types, clock);

function metadataRootFixture() {
  const req = request(), value = grant(req);
  initialPackage(value, req);
  const classificationBytes = growthCanonicalJson({ schemaVersion: "foundation:sdk-growth:metadata-root:1",
    kind: "non-release-metadata-root", packageName: "workspace-root", rootPath: ".", manifestPath: "package.json",
    decisionId: "ROOT-1", ownerRef: "consumer/tooling", releaseHistory: "none" });
  const rootSource = { source: { commit: invocation.sourceCommit, tree: invocation.sourceTree },
    manifestBytes: JSON.stringify({ name: "workspace-root", private: true }), workspaceBytes: "packages:\n  - pkg\n", classificationBytes };
  const root = { evidence: { kind: "non-release-metadata-root", packageName: "workspace-root", rootPath: ".", manifestPath: "package.json",
    classificationPath: "architecture/metadata-root.json", historyDigest: req.binding.historyDigest,
    base: structuredClone(rootSource), candidate: structuredClone(rootSource) }, evidenceDigest: d("1"),
    ownerEvidence: { decisionId: "ROOT-1", ownerRef: "consumer/tooling", decisionDigest: d("1"), authenticatedSubjectId: "owner-1",
      authorizationEvidenceDigest: d("2"), approvalEvidenceDigest: d("3"), sourceBindingDigest: d("4") } };
  const packageEntry = { coordinate: { packageName: "workspace-root", exportPath: ".", resolutionBranch: [], subject: { kind: "package" } },
    value: { state: "present", digest: hashGrowthPayload({ packageName: "workspace-root", rootPath: ".", manifestPath: "package.json",
      moduleType: "commonjs", classification: "governed", explicitExports: false }, fingerprint) } };
  const coverage = { packageName: "workspace-root", classification: "governed", dimensions: growthDimensions.map(dimension => ({
    dimension, status: dimension === "decision" ? "unavailable" : "complete",
    reasons: [dimension === "decision" ? "s1-decision-evidence-unavailable" : "qualified-non-release-metadata-root"] })) };
  value.trustedBase.coverage.push(coverage); value.trustedBase.entries.push(packageEntry);
  value.trustedBase = normalizeGrowthObservation(value.trustedBase);
  value.trustedBaseReference = growthObservationReference(value.trustedBase, fingerprint);
  value.retainedHistory.targetSurfaceDigest = value.trustedBaseReference.surfaceDigest;
  value.retainedHistory.custodyEvidence = custody({ "trusted-base.json": growthCanonicalJson(value.trustedBase) });
  value.retainedHistory.custodyEvidenceDigest = hashGrowthPayload({ domain: "foundation:sdk-growth:custody:1", payload: value.retainedHistory.custodyEvidence }, fingerprint);
  value.metadataRoots = [root];
  const seal = () => {
    root.evidenceDigest = hashGrowthPayload({ domain: "foundation:sdk-growth:metadata-root:1", evidence: root.evidence }, fingerprint);
    root.ownerEvidence.decisionDigest = root.evidenceDigest;
    sealEvidence(value, req);
    root.ownerEvidence.sourceBindingDigest = value.requestDigest;
  };
  seal();
  return { req, value, root, seal, packageEntry, coverage };
}

test("v3 root classification preserves topology without manufacturing an archive or release baseline", async () => {
  const { req, value, packageEntry } = metadataRootFixture();
  const accepted = validateGrowthAuthorityGrant(value, req, fingerprint, now);
  assert.deepEqual(accepted.metadataRoots.map(root => root.evidence.packageName), ["workspace-root"]);
  assert.deepEqual(accepted.candidates.map(row => row.packageName), ["fixture"]);
  assert.deepEqual(accepted.released.map(row => row.packageName), ["fixture"]);
  const local = structuredClone(value.trustedBase);
  local.coverage.find(row => row.packageName === "workspace-root").dimensions.forEach(row => {
    row.status = "unavailable"; row.reasons = ["unqualified-local-root"];
  });
  const observed = await createVerifiedGrowthObservation({ async observe() { return { identity: invocation,
    surface: { status: "available", value: local }, compatibilitySnapshots: local.coverage.map(row => ({ packageName: row.packageName,
      typed: { kind: "typed", snapshot: { status: "unavailable", reasons: ["test"] } },
      artifact: { kind: "artifact", snapshot: { status: "unavailable", reasons: ["test"] } } })) }; } }, {
    packedCandidates: () => accepted.candidates, resolution: () => ({ grant: accepted })
  }, fingerprint).observe(invocation, { throwIfCancelled() {} });
  assert.deepEqual(observed.surface.value.coverage.map(row => row.packageName), ["fixture", "workspace-root"]);
  assert.ok(observed.surface.value.entries.some(row => growthCanonicalJson(row) === growthCanonicalJson(packageEntry)));
});

for (const [name, mutate, reseal = true] of [
  ["private false", root => { root.evidence.candidate.manifestBytes = '{"name":"workspace-root","private":false}'; }],
  ["new exports", root => { root.evidence.candidate.manifestBytes = '{"name":"workspace-root","private":true,"exports":"./index.js"}'; }],
  ["implicit main exposure", root => { root.evidence.candidate.manifestBytes = '{"name":"workspace-root","private":true,"main":"index.js"}'; }],
  ["renamed root", root => { root.evidence.candidate.manifestBytes = '{"name":"renamed","private":true}'; }],
  ["nested private package exemption", root => { root.evidence.rootPath = "packages/private"; }],
  ["changed workspace globs", root => { root.evidence.candidate.workspaceBytes += "  - other/*\n"; }],
  ["reclassification", root => { root.evidence.candidate.classificationBytes = root.evidence.candidate.classificationBytes.replace("consumer/tooling", "other/owner"); }],
  ["stale exact source", root => { root.evidence.candidate.source.commit = "9".repeat(40); }],
  ["missing historical source", root => { delete root.evidence.base; }, false],
  ["missing owner authentication", root => { root.ownerEvidence.authenticatedSubjectId = ""; }],
  ["substituted approval", root => { root.ownerEvidence.decisionDigest = d("f"); }, false],
  ["stale history", root => { root.evidence.historyDigest = d("f"); }],
  ["unknown record key", root => { const record = JSON.parse(root.evidence.candidate.classificationBytes); record.allowAnyPrivatePackage = true;
    root.evidence.base.classificationBytes = root.evidence.candidate.classificationBytes = growthCanonicalJson(record); }],
  ["surviving release history", root => { root.evidence.base.classificationBytes = root.evidence.candidate.classificationBytes = root.evidence.candidate.classificationBytes.replace('"none"', '"released"'); }]
]) {
  test(`metadata root fails closed on ${name}`, () => {
    const { req, value, root, seal } = metadataRootFixture();
    mutate(root); if (reseal) { seal(); }
    assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), /growth-(?:metadata-root|authority)-/);
  });
}

test("metadata evidence cannot replace a selected release obligation or qualify another archive", () => {
  const { req, value } = metadataRootFixture();
  initialPackage(value, req, "workspace-root");
  sealEvidence(value, req); value.metadataRoots[0].ownerEvidence.sourceBindingDigest = value.requestDigest;
  assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), /growth-metadata-root-release-obligation-conflict/);
  const second = metadataRootFixture();
  second.value.metadataRoots = [];
  assert.throws(() => validateGrowthAuthorityGrant(second.value, second.req, fingerprint, now), /evidence-manifest-mismatch/);
});

test("authority v2 is not reinterpreted as metadata-root protocol v3", () => {
  const { req, value } = metadataRootFixture();
  value.schemaVersion = "reviewrouter:sdk-growth-authority:2";
  assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), /growth-authority-grant-invalid/);
});

test("a closed fixture archive completes only its own package, never aggregate peers or metadata root", async () => {
  const { observeClosedFixture } = await import("../scripts/packed-sdk-growth-authority-fixture.mjs");
  const directory = await mkdtemp(join(tmpdir(), "ef-single-package-observer-"));
  try {
    await mkdir(join(directory, "package/dist/data"), { recursive: true });
    await writeFile(join(directory, "package/package.json"), JSON.stringify({ name: "fixture", version: "1.0.0",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./data/*": "./dist/data/*" } }));
    await writeFile(join(directory, "package/dist/index.js"), "export function stable(value) { return value; }\n");
    await writeFile(join(directory, "package/dist/index.d.ts"), "export declare function stable(value: string): string;\n");
    await writeFile(join(directory, "package/dist/data/fixture.txt"), "disposable packed artifact\n");
    const archive = join(directory, "fixture.tgz");
    execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
    const aggregate = observation("fixture", "limited");
    aggregate.coverage.push(observation("other-package", "limited").coverage[0], observation("workspace-root", "limited").coverage[0]);
    aggregate.entries = [
      { coordinate: { packageName: "fixture", exportPath: ".", resolutionBranch: [], subject: { kind: "typed", canonicalReference: "stable" } }, value: { state: "present", digest: d("a") } },
      { coordinate: { packageName: "fixture", exportPath: "./data/*", resolutionBranch: [], subject: { kind: "wildcard-member", member: "fixture.txt" } }, value: { state: "present", digest: d("b") } }
    ];
    const targets = { ".": { kind: "conditions", entries: [
      { condition: "types", value: { kind: "target", target: "./dist/index.d.ts" } },
      { condition: "import", value: { kind: "target", target: "./dist/index.js" } }
    ] }, "./data/*": { kind: "target", target: "./dist/data/*" } };
    for (const [exportPath, tree] of Object.entries(targets)) {
      aggregate.entries.push({ coordinate: { packageName: "fixture", exportPath, resolutionBranch: [], subject: { kind: "export-branch" } },
        value: { state: "present", digest: hashGrowthPayload(tree, fingerprint) } });
    }
    const result = await observeClosedFixture(aggregate, archive);
    assert.ok(result.coverage[0].dimensions.filter(row => row.dimension !== "decision").every(row => row.status === "complete"));
    assert.deepEqual(result.coverage.slice(1), aggregate.coverage.slice(1));
    assert.deepEqual(result.entries, aggregate.entries);
    aggregate.entries.find(row => row.coordinate.subject.kind === "export-branch").value.digest = d("f");
    await assert.rejects(observeClosedFixture(aggregate, archive), /Archive export order must match its own observation/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("authenticated non-release root remains in admitted report while package release obligations remain exact", async () => {
  const { projectGrowthReport } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/project-growth-report.js");
  const { req, value } = metadataRootFixture();
  const accepted = validateGrowthAuthorityGrant(value, req, fingerprint, now);
  const receiptDigest = growthAuthorityGrantDigest(accepted, fingerprint);
  const typed = { ...authoritySnapshot(), packageVersion: "0.0.0" }, artifact = { ...typed, extractorVersion: "package-artifact-inventory/1" };
  const compatibilitySnapshots = [
    { packageName: "fixture", typed: { kind: "typed", snapshot: { status: "available", value: typed } }, artifact: { kind: "artifact", snapshot: { status: "available", value: artifact } } },
    { packageName: "workspace-root", typed: { kind: "typed", snapshot: { status: "unavailable", reasons: ["metadata-root"] } }, artifact: { kind: "artifact", snapshot: { status: "unavailable", reasons: ["metadata-root"] } } }
  ];
  const context = { trustedBase: { status: "available", value: accepted.trustedBase }, trustedBaseReference: { status: "available", value: accepted.trustedBaseReference },
    retainedHistory: { status: "available", value: { targetSurfaceDigest: accepted.trustedBaseReference.surfaceDigest, receiptDigest: d("d") } },
    released: [{ packageName: "fixture", policy: { packageName: "fixture", approvedBreakingChanges: [] },
      releaseEvidence: { status: "available", value: { packageName: "fixture", packageVersion: "0.0.0", declaredBump: "minor" } },
      qualification: { receiptDigest }, evidence: { kind: "initial-unreleased", history: { status: "available", value: req.binding.historyDigest } } }],
    nonReleaseMetadataRoots: [{ packageName: "workspace-root", receiptDigest }], decisions: [],
    acceptedBreakingDecisions: { acceptedDecisionIds: [], acceptedDecisionPaths: [], growthDecisionAuthority: { status: "available", value: [] } },
    authority: { status: "verified", receiptDigest, workflowRef: "test", runRef: "run" } };
  const run = () => admitSdkGrowth({ invocation, context: req.contextSelectors, cancellation: { throwIfCancelled() {} } }, {
    observation: createVerifiedGrowthObservation({ async observe() { return { identity: invocation,
      surface: { status: "available", value: accepted.trustedBase }, compatibilitySnapshots }; } }, {
      packedCandidates: () => accepted.candidates, resolution: () => ({ grant: accepted })
    }, fingerprint), context: { async read() { return context; } }, fingerprint });
  const report = projectGrowthReport(await run(), fingerprint, []);
  assert.equal(report.verdict, "admitted"); assert.equal(report.releaseEligible, true);
  assert.deepEqual(report.coverage.map(row => row.packageName), ["fixture", "workspace-root"]);
  assert.deepEqual(report.released.map(row => row.packageName), ["fixture"]);
  context.nonReleaseMetadataRoots = [];
  assert.equal((await run()).admission.status, "incomplete");
  context.nonReleaseMetadataRoots = [{ packageName: "workspace-root", receiptDigest: d("f") }];
  await assert.rejects(run(), /growth-metadata-root-qualification-invalid/);
});

test("metadata classification verifies committed source files independently of the authenticated payload", async () => {
  const { assertGrowthMetadataRootSources } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/growth-metadata-root-sources.js");
  const { readContainedRegularFile } = await import("../packages/engineering-foundation/dist/source-inventory/node.js");
  const directory = await mkdtemp(join(tmpdir(), "ef-metadata-source-"));
  try {
    const { root } = metadataRootFixture();
    await mkdir(join(directory, "architecture"));
    await writeFile(join(directory, "package.json"), root.evidence.candidate.manifestBytes);
    await writeFile(join(directory, "pnpm-workspace.yaml"), root.evidence.candidate.workspaceBytes);
    await writeFile(join(directory, root.evidence.classificationPath), root.evidence.candidate.classificationBytes);
    const git = args => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
    git(["init", "--quiet"]); git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "metadata evidence"]);
    const source = { commit: git(["rev-parse", "HEAD"]).trim(), tree: git(["rev-parse", "HEAD^{tree}"]).trim() };
    root.evidence.base.source = source; root.evidence.candidate.source = source;
    const verify = () => assertGrowthMetadataRootSources([root], directory, { files: { read: readContainedRegularFile },
      async runGit(args) { return { exitCode: 0, stdout: git(args) }; } }, { throwIfCancelled() {} });
    await verify();
    await writeFile(join(directory, root.evidence.classificationPath), "{}");
    await assert.rejects(verify(), /growth-metadata-root-working-bytes-mismatch/);
    await writeFile(join(directory, root.evidence.classificationPath), root.evidence.candidate.classificationBytes);
    root.evidence.base.workspaceBytes += "  - omitted/*\n";
    await assert.rejects(verify(), /growth-metadata-root-source-bytes-mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

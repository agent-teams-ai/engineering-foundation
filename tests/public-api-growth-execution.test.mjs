import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import test from "node:test";
import { check, withPublicApiFixture } from "./support/capability-fixtures.mjs";

test("existing public check route preserves v1 and publishes deterministic incomplete v2 evidence with exit 2", async () => {
  await withPublicApiFixture(async root => {
    assert.equal(check(root).result.status, 0);
    const configPath = join(root, "architecture/foundation/public-api-compatibility.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    await cp("tests/fixtures/governance-architecture-decisions/valid", root, { recursive: true });
    await cp("tests/fixtures/governance-architecture-decisions/valid/governance-architecture-decisions.yaml", join(root, "architecture/foundation/governance-architecture-decisions.yaml"));
    config.schemaVersion = 2;
    config.governanceConfigPath = "architecture/foundation/governance-architecture-decisions.yaml";
    config.sdkGrowth = {
      contractRevision: "foundation:sdk-growth:c0:5", policyVersion: "foundation:sdk-growth:policy:1",
      comparison: { trustedBasePath: "evidence/base.json", released: [
        { packageName: "@fixture/public-api", kind: "released", observationPath: "evidence/released.json" }
      ] }, decisionsPath: "evidence/decisions.json", reportPath: "reports/sdk.json"
    };
    await writeFile(configPath, stringify(config));
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await mkdir(join(root, "reports"));
    await mkdir(join(root, "evidence"));
    await writeFile(join(root, "evidence/decisions.json"), "[]");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture-root", private: true, version: "1.0.0" }));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "add", "packages"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    const first = check(root);
    assert.equal(first.result.status, 2, JSON.stringify(first.report));
    const capability = first.report.capabilities[0];
    assert.equal(capability.capabilityConfigSchemaVersion, 2);
    assert.equal(capability.problem.code, "SDK_GROWTH_EVIDENCE_INCOMPLETE");
    assert.ok(capability.diagnostics.some(row => row.ruleId === "package.public-api-compatibility.sdk-growth-report"), JSON.stringify(capability));
    const bytes = await readFile(join(root, "reports/sdk.json"));
    const report = JSON.parse(bytes);
    assert.equal(report.verdict, "incomplete");
    assert.equal(report.releaseEligible, false);
    assert.equal(report.contractRevision, "foundation:sdk-growth:c0:5");
    assert.deepEqual(report.transitionReceipts, []);
    assert.deepEqual(report.phases.map(row => row.name), ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"]);
    assert.equal(report.phases.find(row => row.name === "authority").status, "unavailable");
    assert.ok(report.trustedBaseComparison.reasons.includes("growth-authority-unverified"));
    assert.deepEqual(check(root).report, first.report);
    assert.deepEqual(await readFile(join(root, "reports/sdk.json")), bytes);
    const { sourceCommit, sourceTree, topologyDigest, lockDigest, toolchainDigest, artifactDigests } = report.candidate.value;
    const base = { contractRevision: report.contractRevision, observationVersion: "foundation:sdk-growth:observation:1",
      repository: report.repository, sourceCommit, sourceTree, topologyDigest, lockDigest, toolchainDigest, artifactDigests,
      tool: report.tool, coverage: report.coverage, entries: Array.from({ length: 100001 }, () => ({})) };
    await writeFile(join(root, "evidence/base.json"), JSON.stringify(base));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# Later observed inputs\n");
    const later = check(root);
    assert.equal(later.result.status, 2, JSON.stringify(later.report));
    assert.equal(later.report.capabilities[0].problem.code, "SDK_GROWTH_EVIDENCE_INCOMPLETE");
    const updated = await readFile(join(root, "reports/sdk.json"));
    assert.notDeepEqual(updated, bytes);
    assert.equal(JSON.parse(updated).trustedBase.status, "unavailable");
    assert.notEqual(JSON.parse(updated).candidate.value.lockDigest, report.candidate.value.lockDigest);
    assert.deepEqual(check(root).report, later.report);
    assert.deepEqual(await readFile(join(root, "reports/sdk.json")), updated);
    base.entries = [];
    base.sourceCommit = "invalid";
    await writeFile(join(root, "evidence/base.json"), JSON.stringify(base));
    assert.equal(check(root).result.status, 3);
    assert.deepEqual(await readFile(join(root, "reports/sdk.json")), updated);
  });
});

test("v2 rejects protected report destinations before loading execution inputs", async () => {
  const { loadCapabilityConfig } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js");
  const { assertSchema } = await import("../packages/engineering-foundation/dist/schema-catalog.js");
  const template = JSON.parse(await readFile("architecture/contracts/sdk-growth-v2/valid.json", "utf8"));
  template.governanceConfigPath = "governance/catalog.yaml";
  const protectedPaths = [
    "config/check.yaml", "governance/catalog.yaml", ".changeset", ".changeset/addition.md",
    "architecture/decisions/accepted-decisions.json", "architecture/decisions/ADR-0001.md",
    "architecture/public-api/sdk-packed-fixture.json", "architecture/contracts/release.json",
    "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "package-lock.json",
    "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", ".git/config",
    "node_modules/dependency/index.js", ".github/workflows/ci.yml", "foundation.config.yaml", ".npmrc", "src/index.ts", "scripts/check.mjs", "tests/fixture.json",
    "evidence/base.json", "evidence/decisions.json", "evidence/released.json",
    "docs/decisions", "docs/decisions/new.md", "docs/decisions/README.md", "docs", "tsconfig.json", "tsconfig.base.json",
    "pkg", "pkg/package.json", "pkg/tsconfig.json", "pkg/dist/index.d.ts",
    "pkg/src/new-source.ts", "pkg/assets/new.json", "evidence", "config", "governance"
  ];
  for (const destination of protectedPaths) {
    const config = structuredClone(template);
    config.sdkGrowth.reportPath = destination;
    await assert.rejects(loadCapabilityConfig({ readYaml: async (_root, path) => path === config.governanceConfigPath
      ? parse(await readFile("tests/fixtures/governance-architecture-decisions/valid/governance-architecture-decisions.yaml", "utf8")) : config, assertSchema }, "/unused", "config/check.yaml"),
      error => error.problem?.code === "PUBLIC_API_COMPATIBILITY_CONFIG_INVALID" || /overlaps a protected/.test(error.message), destination);
  }
  for (const destination of [" ", " reports/sdk.json", "reports/sdk.json ", "C:/reports/sdk.json", "reports/./sdk.json", "reports//sdk.json"]) {
    const config = structuredClone(template);
    config.sdkGrowth.reportPath = destination;
    await assert.rejects(loadCapabilityConfig({ readYaml: async (_root, path) => path === config.governanceConfigPath
      ? parse(await readFile("tests/fixtures/governance-architecture-decisions/valid/governance-architecture-decisions.yaml", "utf8")) : config, assertSchema }, "/unused", "config/check.yaml"),
      error => error.name === "CapabilityInputError", destination);
  }
  for (const destination of ["reports/sdk.json", "pkg-reports/sdk.json", "evidence/results/sdk.json"]) {
    const config = structuredClone(template);
    config.sdkGrowth.reportPath = destination;
    assert.equal((await loadCapabilityConfig({ readYaml: async (_root, path) => path === config.governanceConfigPath
      ? parse(await readFile("tests/fixtures/governance-architecture-decisions/valid/governance-architecture-decisions.yaml", "utf8")) : config, assertSchema }, "/unused", "config/check.yaml")).schemaVersion, 2);
  }
});

test("report projection validates complete receipts and truthful unavailable and failed phases", async () => {
  const { createHash } = await import("node:crypto");
  const { projectGrowthReport } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/project-growth-report.js");
  const { validateGrowthReport } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-report.js");
  const { growthObservationReference } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js");
  const { compareGrowthSurfaces } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js");
  const fingerprint = { sha256: value => createHash("sha256").update(value).digest("hex") };
  const digest = `sha256:${"1".repeat(64)}`;
  const identity = { repository: "test-only/report", sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40),
    topologyDigest: digest, lockDigest: digest, toolchainDigest: digest, artifactDigests: [digest],
    tool: { version: "test-only", artifactDigest: digest, extractorVersion: "test-only" } };
  const surface = { status: "available", value: { ...identity, contractRevision: "foundation:sdk-growth:c0:5", observationVersion: "foundation:sdk-growth:observation:1",
    coverage: [{ packageName: "fixture", classification: "governed", dimensions: ["topology", "resolution", "typed", "reachable", "runtime", "bin", "data", "wildcard", "packed", "decision"]
      .map(dimension => ({ dimension, status: dimension === "decision" ? "unavailable" : "complete", reasons: ["test-only-observation"] })) }], entries: [] } };
  const execution = { observation: { identity, surface, compatibilitySnapshots: [] }, baseSurface: surface,
    baseReference: { status: "available", value: growthObservationReference(surface.value, fingerprint) },
    authority: { status: "verified", receiptDigest: digest, workflowRef: "test-only/workflow", runRef: "test-only/run" },
    admission: { status: "admitted", admittedTransitions: [], diagnostics: [], releaseEligible: false }, decisionDigests: [],
    comparison: compareGrowthSurfaces({ trustedBefore: surface, candidateAfter: surface }, fingerprint),
    compatibility: { status: "complete", diagnostics: [], reasons: [] },
    released: [{ packageName: "fixture", observation: surface, evidence: { kind: "released" } }] };
  const complete = validateGrowthReport(projectGrowthReport(execution, fingerprint), fingerprint);
  assert.equal(complete.verdict, "admitted");
  assert.ok(complete.phases.every(row => row.status === "complete"));
  assert.equal(complete.transitionReceipts.length, 1);
  assert.equal(complete.transitionReceipts[0].trustedRunRef, "test-only/run");
  const initial = structuredClone(execution);
  initial.observation.surface.value.entries = [{ coordinate: { packageName: "fixture", exportPath: ".", resolutionBranch: [],
    subject: { kind: "typed", canonicalReference: "NewApi" } }, value: { state: "present", digest } }];
  initial.baseSurface = structuredClone(initial.observation.surface);
  initial.baseReference = { status: "available", value: growthObservationReference(initial.baseSurface.value, fingerprint) };
  initial.comparison = compareGrowthSurfaces({ trustedBefore: initial.baseSurface, candidateAfter: initial.observation.surface }, fingerprint);
  initial.released = [{ packageName: "fixture", evidence: { kind: "initial-unreleased", history: { status: "available", value: digest } } }];
  const initialReport = validateGrowthReport(projectGrowthReport(initial, fingerprint), fingerprint);
  assert.equal(initialReport.verdict, "admitted");
  assert.equal(initialReport.releasedComparison.status, "complete");
  assert.equal(initialReport.releasedComparison.transitions.length, 1);
  assert.deepEqual(initialReport.releasedComparison.transitions[0].before, { state: "absent" });
  assert.deepEqual(initialReport.releasedComparison.transitions[0].after, { state: "present", digest });
  assert.deepEqual(initialReport.released[0].evidence, initial.released[0].evidence);
  initial.released[0].evidence.history = { status: "unavailable", reasons: ["no-trusted-initial-history"] };
  const invalidPolicy = structuredClone(initialReport);
  invalidPolicy.releasedComparison.transitions[0].policyVersion = "unknown";
  assert.throws(() => validateGrowthReport(invalidPolicy, fingerprint), { reason: "invalid-growth-report" });
  const missingInitial = validateGrowthReport(projectGrowthReport(initial, fingerprint), fingerprint);
  assert.equal(missingInitial.verdict, "incomplete");
  assert.deepEqual(missingInitial.transitionReceipts, []);
  assert.equal(missingInitial.released[0].evidence.kind, "initial-unreleased");
  const unavailable = structuredClone(execution);
  unavailable.authority = { status: "unverified", reasons: ["z", "a"] };
  const incomplete = validateGrowthReport(projectGrowthReport(unavailable, fingerprint), fingerprint);
  assert.equal(incomplete.verdict, "incomplete");
  assert.deepEqual(incomplete.transitionReceipts, []);
  assert.deepEqual(incomplete.authority.reasons, ["a", "z"]);
  assert.equal(incomplete.phases.find(row => row.name === "authority").status, "unavailable");
  for (const field of ["workflowRef", "runRef"]) {
    for (const value of [undefined, null, "", " \t\n"]) {
      const missingAuthority = structuredClone(execution);
      missingAuthority.authority[field] = value;
      const report = validateGrowthReport(projectGrowthReport(missingAuthority, fingerprint), fingerprint);
      assert.deepEqual(report.authority, { status: "unverified", reasons: ["growth-workflow-and-run-reference-unavailable"] });
      assert.equal(report.verdict, "incomplete");
      assert.equal(report.releaseEligible, false);
      assert.deepEqual(report.transitionReceipts, []);
    }
  }
  for (const reasons of [[], "reason", [1], [null], [" "]]) {
    const malformed = structuredClone(incomplete);
    malformed.authority.reasons = reasons;
    assert.throws(() => validateGrowthReport(malformed, fingerprint), { reason: "invalid-growth-report" });
  }
  const broken = structuredClone(execution);
  broken.compatibility.status = "rejected";
  const rejected = validateGrowthReport(projectGrowthReport(broken, fingerprint), fingerprint);
  assert.equal(rejected.verdict, "rejected");
  assert.equal(rejected.phases.find(row => row.name === "released").status, "failed");
  assert.deepEqual(rejected.transitionReceipts, []);
  for (const mutate of [
    report => { report.extra = true; },
    report => { report.tool = null; },
    report => { report.contractRevision = "unknown"; },
    report => { report.policyVersion = "unknown"; },
    report => { report.candidate = { status: "unknown", reasons: ["reason"] }; },
    report => { report.released[0].evidence = { kind: "unknown", history: { status: "available", value: digest } }; },
    report => { report.phases.reverse(); },
    report => { report.tool.artifactDigest = "not-a-digest"; },
    report => { report.transitionReceipts[0].transitions = [digest]; },
    report => { report.coverage[0].dimensions.push(report.coverage[0].dimensions[0]); }
  ]) {
    const invalid = structuredClone(complete); mutate(invalid);
    assert.throws(() => validateGrowthReport(invalid, fingerprint));
  }
});


test("report destination rejects missing parents, symlinks, directories and hardlinks before execution", async () => {
  const { mkdtemp, rm, symlink, link } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { assertGrowthDestination } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/growth-invocation.js");
  const root = await mkdtemp(join(tmpdir(), "sdk-destination-"));
  try {
    await mkdir(join(root, "reports"));
    await writeFile(join(root, "input.json"), "protected-input");
    await symlink(join(root, "reports"), join(root, "linked-parent"));
    await symlink(join(root, "input.json"), join(root, "reports/link.json"));
    await link(join(root, "input.json"), join(root, "reports/hardlink.json"));
    for (const path of ["missing/report.json", "input.json/report.json", "linked-parent/report.json", "reports/link.json", "reports/hardlink.json", "reports"]) {
      await assert.rejects(assertGrowthDestination(root, path), error => error.name === "CapabilityInputError", path);
    }
    await assertGrowthDestination(root, "reports/new.json");
    await writeFile(join(root, "reports/existing.json"), "existing-report");
    await assertGrowthDestination(root, "reports/existing.json");
    assert.equal(await readFile(join(root, "input.json"), "utf8"), "protected-input");
  } finally { await rm(root, { recursive: true, force: true }); }
});

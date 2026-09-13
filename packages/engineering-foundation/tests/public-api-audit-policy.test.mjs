import assert from "node:assert/strict";
import test from "node:test";
import { auditPublicApi } from "../dist/capabilities/public-api-compatibility/application/use-cases/audit-public-api.js";
import { publicApiAuditPairEligibility } from "../dist/capabilities/public-api-compatibility/application/policies/public-api-audit-eligibility.js";
const profile = "foundation:public-api-audit:declaration-graph:1";
const digest = `sha256:${"0".repeat(64)}`;
function observation(subject, packageName, signature = "export declare function f(): string;") {
  const item = { displayName: "f", identity: { subject, packageName, exportPath: ".", canonicalReference: `${packageName}!f:function(1)` }, kind: "Function", parentReference: `${packageName}!`, parentKind: "EntryPoint", excerpt: signature, isExported: true, public: true, references: [] };
  return { subject, packageName, packageVersion: "1.0.0", exportPath: ".", modelExpected: true, toolchain: "fixture-toolchain", normalizationProfile: profile, compilerEnvironment: "fixture-options", compilerOptions: {}, configurationDependencies: [], sourceFiles: [], externalDeclarations: [], diagnostics: [], compilerDiagnosticsCollected: true,
    invocation: { outcome: "completed", succeeded: true, errorCount: 0, warningCount: 0 }, modelPresent: true, modelDigest: digest, items: [item], inputBytesRevalidated: true, unsupported: [],
    storedSurface: { schemaVersion: 1, packageName, packageVersion: "1.0.0", extractorVersion: "fixture-toolchain", entrypoints: [{ exportPath: ".", items: [{ canonicalReference: item.identity.canonicalReference, kind: item.kind, parentReference: item.parentReference, parentKind: item.parentKind, signature }] }] } };
}
async function audit(observations, badBaseline) {
  const packages = [...new Set(observations.map(item => item.packageName))].map(packageName => ({ packageName, packageVersion: "1.0.0", manifestPath: `${packageName}/package.json`, tsconfigPath: `${packageName}/tsconfig.json`, entrypoints: [{ exportPath: ".", declarationEntryPoint: `${packageName}/index.d.ts` }], nonTypeExports: [] }));
  const request = { schemaVersion: 1, subjects: {
    A: { packages, files: [], resolutionUniverse: [], archive: { digest, extractedMembers: [] } },
    C: { packages, files: [], resolutionUniverse: [], build: { sourceIdentity: "fixture", buildIdentity: "fixture", declarations: [] } },
    B: { baselines: packages.map(pkg => ({ packageName: pkg.packageName, path: `${pkg.packageName}.json`, digest })) }
  } };
  return auditPublicApi({ consumerRoot: "fixture", configPath: "fixture.json", foundationVersion: "fixture" }, {
    inputs: { load: async () => ({ request, digest }), revalidate: async () => {}, baseline: async (_root, input) => {
      if (input.packageName === badBaseline) {throw new Error("Invalid historical baseline");}
      return observations.find(item => item.subject === "A" && item.packageName === input.packageName).storedSurface;
    } }, observer: { observe: async input => observations.filter(item => item.subject === input.subject) }, fingerprint: { sha256: () => "0".repeat(64) }
  });
}

test("unrelated failed model and baseline do not erase valid package comparisons", async () => {
  const observations = [observation("A", "broken"), { ...observation("C", "broken"), modelPresent: false }, observation("A", "valid"), observation("C", "valid")];
  const report = await audit(observations, "broken");
  assert.equal(report.exitCode, 2);
  assert.equal(report.evidenceComplete, false);
  assert.deepEqual(report.comparisons.filter(item => item.packageName === "valid").map(item => [item.eligibility.eligible, item.findings.classification]), [[true, "none"], [true, "none"], [true, "none"]]);
  assert.ok(report.comparisons.filter(item => item.packageName === "broken").every(item => !item.eligibility.eligible && item.findings === undefined));
});
test("a nonempty bounded finding with complete successful evidence exits zero", async () => {
  const report = await audit([observation("A", "valid"), observation("C", "valid", "export declare function f(): number;")]);
  assert.equal(report.exitCode, 0);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.evidenceComplete, true);
  assert.equal(report.comparisons.find(item => item.pair === "A-C").findings.classification, "breaking");
});
test("tool, compiler configuration and library identity mismatches deny rich admission independently", () => {
  const a = observation("A", "valid");
  const c = observation("C", "valid");
  assert.ok(publicApiAuditPairEligibility([a], [{ ...c, toolchain: "other" }]).reasons.includes("toolchain-mismatch"));
  assert.ok(publicApiAuditPairEligibility([a], [{ ...c, compilerEnvironment: "other" }]).reasons.includes("compiler-environment-mismatch"));
  assert.ok(publicApiAuditPairEligibility([a], [{ ...c, externalDeclarations: [{ path: "lib.es5.d.ts", digest }] }]).reasons.includes("compiler-library-mismatch"));
  assert.ok(publicApiAuditPairEligibility([a], [{ ...c, compilerDiagnosticsCollected: false }]).reasons.includes("compiler-diagnostics-unavailable"));
});

test("unsupported runtime profiles deny comparison without discarding observations", async () => {
  for (const normalizationProfile of ["unsupported", undefined, null, 1, {}]) {
    const observations = [observation("A", "valid"), { ...observation("C", "valid"), normalizationProfile }];
    assert.deepEqual(publicApiAuditPairEligibility([observations[0]], [observations[1]]), {
      eligible: false, reasons: ["unsupported-profile"]
    });
    const report = await audit(observations);
    assert.equal(report.exitCode, 2);
    assert.equal(report.evidenceComplete, false);
    assert.equal(report.releaseEligible, false);
    assert.deepEqual(report.observations, observations);
    const comparison = report.comparisons.find(item => item.pair === "A-C");
    assert.deepEqual(comparison.eligibility, { eligible: false, reasons: ["unsupported-profile"] });
    assert.equal(comparison.findings, undefined);
  }
});

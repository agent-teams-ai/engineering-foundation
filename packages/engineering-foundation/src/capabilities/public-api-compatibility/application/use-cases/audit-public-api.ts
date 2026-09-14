import type { AuditPackageInput } from "../../contract/public-api-audit.js";
import type { PublicApiAuditReport, AuditComparison } from "../model/public-api-audit-report.js";
import type { PublicApiAuditInputs, PublicApiObserver } from "../ports/public-api-observer.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type { AuditObservation } from "../model/public-api-observation.js";
import type { PublicApiSnapshot } from "../model/public-api.js";
import { classifyPublicApiChange } from "../policies/evaluate-public-api-compatibility.js";
import { publicApiAuditPairEligibility } from "../policies/public-api-audit-eligibility.js";
import { projectPublicApiObservation } from "../policies/project-public-api-observation.js";
import { assertNotCancelled } from "../policies/public-api-evidence-errors.js";

const HISTORICAL_LIMITATIONS = ["B records stored declarations only; original export visibility is not reconstructible.", "B lacks hidden declarations, ordered reference targets and compiler-input closure.", "Stored-surface findings do not qualify a rich comparison or release admission."];
function stored(observations: readonly AuditObservation[], pkg: AuditPackageInput): PublicApiSnapshot | undefined {
  const selected = observations.filter((observation) => observation.packageName === pkg.packageName);
  if (selected.length !== Math.max(1, pkg.entrypoints.length) || selected.some((observation) => observation.storedSurface === undefined || !observation.inputBytesRevalidated)) {return undefined;}
  return { schemaVersion: 1, packageName: pkg.packageName, packageVersion: pkg.packageVersion,
    extractorVersion: selected[0]?.storedSurface?.extractorVersion ?? "",
    entrypoints: selected.flatMap((observation) => observation.storedSurface?.entrypoints ?? []) };
}
/** Admit each package with its declared reference dependencies, never unrelated packages. */
function packageScope(observations: readonly AuditObservation[], packageName: string): readonly AuditObservation[] {
  const names = new Set([packageName]);
  const pending = [packageName];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const observation of observations.filter((candidate) => candidate.packageName === current)) {
      for (const reference of observation.items.flatMap((item) => item.references)) {
        const dependency = reference.target?.packageName;
        if (dependency !== undefined && !names.has(dependency)) { names.add(dependency); pending.push(dependency); }
      }
    }
  }
  return observations.filter((observation) => names.has(observation.packageName));
}

function completeExportCoverage(observations: readonly AuditObservation[], pkg: AuditPackageInput | undefined): boolean {
  if (pkg === undefined) {return false;}
  const expected = pkg.entrypoints.map((entry) => entry.exportPath).toSorted();
  const observed = observations.filter((observation) => observation.packageName === pkg.packageName).flatMap((observation) => observation.exportPath === null ? [] : [observation.exportPath]).toSorted();
  return JSON.stringify(expected) === JSON.stringify(observed);
}
function retainComparison(comparisons: AuditComparison[], comparison: AuditComparison, budget: { characters: number }): void {
  const size = JSON.stringify(comparison).length;
  if (budget.characters + size > 16 * 1024 * 1024) {
    comparisons.push({ pair: comparison.pair, packageName: comparison.packageName, scope: comparison.scope,
      eligibility: { eligible: false, reasons: [...comparison.eligibility.reasons, "comparison-output-budget-exhausted"] }, limitations: comparison.limitations });
    return;
  }
  budget.characters += size;
  comparisons.push(comparison);
}
function historicalComparison(input: {
  readonly pair: "A-B" | "B-C"; readonly packageName: string;
  readonly observed: PublicApiSnapshot | undefined; readonly baseline: PublicApiSnapshot | undefined;
  readonly inputsRevalidated: boolean;
}, fingerprint: ChangeFingerprint): AuditComparison {
  const { pair, packageName, observed, baseline } = input;
  const reasons = input.inputsRevalidated ? [] : ["input-evidence-failure"];
  if (observed === undefined || baseline === undefined) {reasons.push("stored-surface-unavailable");}
  if (observed !== undefined && baseline !== undefined && observed.extractorVersion !== baseline.extractorVersion) {reasons.push("historical-extractor-version-mismatch");}
  const findings = reasons.length > 0 || observed === undefined || baseline === undefined ? undefined
    : classifyPublicApiChange(pair === "A-B" ? observed : baseline, pair === "A-B" ? baseline : observed, fingerprint);
  return { pair, packageName, scope: "historical-stored-surface", eligibility: { eligible: reasons.length === 0, reasons }, limitations: HISTORICAL_LIMITATIONS,
    ...(findings === undefined ? {} : { findings }) };
}
function richComparison(input: {
  readonly a: readonly AuditObservation[]; readonly c: readonly AuditObservation[];
  readonly packageName: string; readonly packagesPresent: boolean; readonly coverageComplete: boolean; readonly inputsRevalidated: boolean;
}, fingerprint: ChangeFingerprint): AuditComparison {
  const aScope = packageScope(input.a, input.packageName);
  const cScope = packageScope(input.c, input.packageName);
  const reasons = [...publicApiAuditPairEligibility(aScope, cScope).reasons];
  if (!input.packagesPresent) {reasons.push("package-unavailable");}
  if (!input.coverageComplete) {reasons.push("incomplete-export-path-observations");}
  if (!input.inputsRevalidated) {reasons.push("input-evidence-failure");}
  let projections: Pick<AuditComparison, "findings" | "beforeProjection" | "afterProjection"> = {};
  if (reasons.length === 0) {
    try {
      const beforeProjection = projectPublicApiObservation(aScope, input.packageName);
      const afterProjection = projectPublicApiObservation(cScope, input.packageName);
      const auditFingerprint = { sha256: (value: string) => fingerprint.sha256(`foundation:public-api-audit:declaration-graph:1\n${value}`) };
      projections = { beforeProjection, afterProjection, findings: classifyPublicApiChange(beforeProjection.snapshot, afterProjection.snapshot, auditFingerprint) };
    } catch (error) { reasons.push(`unsupported-graph: ${String(error)}`); }
  }
  return { pair: "A-C", packageName: input.packageName, scope: "declaration-graph", eligibility: { eligible: reasons.length === 0, reasons }, limitations: ["Bounded declaration/reference comparison; no assignability or semantic-equivalence claim."], ...projections };
}

export async function auditPublicApi(input: {
  readonly consumerRoot: string; readonly configPath: string; readonly foundationVersion: string; readonly signal?: AbortSignal;
}, dependencies: { readonly inputs: PublicApiAuditInputs; readonly observer: PublicApiObserver; readonly fingerprint: ChangeFingerprint }): Promise<PublicApiAuditReport> {
  assertNotCancelled(input.signal);
  const loaded = await dependencies.inputs.load(input.consumerRoot, input.configPath);
  const request = loaded.request;
  const observations: AuditObservation[] = [];
  const comparisons: AuditComparison[] = [];
  const comparisonBudget = { characters: 0 };
  const baselineBudget = { bytes: 0, files: 0 };
  const errors: string[] = [];
  for (const subject of ["A", "C"] as const) {
    assertNotCancelled(input.signal);
    try { observations.push(...await dependencies.observer.observe({ consumerRoot: input.consumerRoot, subject, declarations: request.subjects[subject], ...(input.signal === undefined ? {} : { signal: input.signal }) })); }
    catch (error) { errors.push(`${subject}: ${String(error)}`); }
  }
  try { await dependencies.inputs.revalidate(input.consumerRoot, request); }
  catch (error) { errors.push(`Input revalidation failed: ${String(error)}`); }
  const inputsRevalidated = errors.length === 0;
  const a = observations.filter((observation) => observation.subject === "A");
  const c = observations.filter((observation) => observation.subject === "C");
  const names = [...new Set([...request.subjects.A.packages, ...request.subjects.C.packages, ...request.subjects.B.baselines].map((pkg) => pkg.packageName))].toSorted();
  for (const packageName of names) {
    const aPackage = request.subjects.A.packages.find((pkg) => pkg.packageName === packageName);
    const cPackage = request.subjects.C.packages.find((pkg) => pkg.packageName === packageName);
    let baseline: PublicApiSnapshot | undefined;
    const b = request.subjects.B.baselines.find((pkg) => pkg.packageName === packageName);
    if (b !== undefined) {
      try { baseline = await dependencies.inputs.baseline(input.consumerRoot, b, baselineBudget); }
      catch (error) { errors.push(`B/${packageName}: ${String(error)}`); }
    }
    retainComparison(comparisons, historicalComparison({ pair: "A-B", packageName, observed: aPackage === undefined ? undefined : stored(a, aPackage), baseline, inputsRevalidated }, dependencies.fingerprint), comparisonBudget);
    retainComparison(comparisons, historicalComparison({ pair: "B-C", packageName, observed: cPackage === undefined ? undefined : stored(c, cPackage), baseline, inputsRevalidated }, dependencies.fingerprint), comparisonBudget);
    retainComparison(comparisons, richComparison({ a, c, packageName, packagesPresent: aPackage !== undefined && cPackage !== undefined, coverageComplete: completeExportCoverage(a, aPackage) && completeExportCoverage(c, cPackage), inputsRevalidated }, dependencies.fingerprint), comparisonBudget);
  }
  assertNotCancelled(input.signal);
  const evidenceComplete = errors.length === 0 && comparisons.length > 0 && comparisons.every((comparison) => comparison.eligibility.eligible);
  const failed = observations.some((observation) => (observation.modelExpected && !observation.invocation.succeeded) || observation.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
  return { schemaVersion: 1, operation: "public-api-audit", releaseEligible: false, foundationVersion: input.foundationVersion, requestDigest: loaded.digest,
    custody: { supplied: request.subjects, archiveProvenanceVerified: false, archiveDigestVerified: false, archiveInventoryCompletenessVerified: false, buildExecutionVerified: false }, observations, comparisons, evidenceComplete, errors,
    exitCode: evidenceComplete && !failed ? 0 : 2 };
}

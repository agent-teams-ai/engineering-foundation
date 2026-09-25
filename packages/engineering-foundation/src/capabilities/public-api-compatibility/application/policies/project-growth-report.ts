import { compareGrowthSurfaces, hashGrowthPayload } from "./compare-growth-surfaces.js";
import type { GrowthComparison } from "../model/growth-admission.js";
import type { SdkGrowthAdmissionExecution } from "../use-cases/admit-sdk-growth.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { growthDimensions } from "../model/growth-observation.js";
import type { GrowthCoverage } from "../model/growth-observation.js";
import type { GrowthReport } from "../model/growth-report.js";
import { growthReportPhases } from "../model/growth-report.js";
import { growthCanonicalJson, growthObservationReference, growthUniqueSorted, normalizeGrowthObservation } from "./normalize-growth-observation.js";

/** Project only retained evidence. V1 release snapshots cannot manufacture
 * released growth observations or trusted transition receipts. */
export function projectGrowthReport(execution: SdkGrowthAdmissionExecution, fingerprint: ChangeFingerprint): GrowthReport {
  const surface = execution.observation.surface;
  const candidate = surface.status === "available" ? { status: "available" as const,
    value: growthObservationReference(surface.value, fingerprint) } : surface;
  const authority = projectAuthority(execution.authority);
  const releasedComparison = compareReleased(execution, fingerprint);
  const decisionComplete = authority.status === "verified" && execution.admission.status !== "incomplete";
  const coverage = reportCoverage(execution, decisionComplete);
  const released: GrowthReport["released"] = growthUniqueSorted(execution.released, (row) => row.packageName).map((row) => ({
    packageName: row.packageName, evidence: row.evidence.kind === "initial-unreleased"
      ? { kind: "initial-unreleased", history: row.evidence.history }
      : { kind: "released", observation: row.observation?.status === "available"
          ? { status: "available", value: growthObservationReference(row.observation.value, fingerprint) }
          : row.observation ?? { status: "unavailable", reasons: ["growth-released-aggregate-unavailable"] } }
  }));
  const dimensionStatus = (dimensions: readonly string[]): "complete" | "unavailable" =>
    execution.baseSurface.status === "available" && surface.status === "available" && coverage.length > 0 && coverage.every((row) => row.dimensions.filter((entry) => dimensions.includes(entry.dimension)).every((entry) => entry.status === "complete"))
      ? "complete" : "unavailable";
  const statuses = {
    topology: dimensionStatus(["topology"]),
    observation: dimensionStatus(["resolution", "typed", "reachable", "runtime", "bin", "data", "wildcard"]),
    packed: dimensionStatus(["packed"]), decision: !decisionComplete ? "unavailable" : execution.admission.status === "rejected" ? "failed" : "complete",
    "trusted-base": execution.comparison.status === "complete" ? "complete" : "unavailable",
    released: execution.compatibility.status === "rejected" ? "failed" : releasedComparison.status === "complete" && execution.compatibility.status === "complete" ? "complete" : "unavailable",
    authority: authority.status === "verified" ? "complete" : "unavailable"
  } as const;
  const phases = growthReportPhases.map((name) => ({ name, status: statuses[name] }));
  const verdict = phases.some((phase) => phase.status === "unavailable") || execution.admission.status === "incomplete" ? "incomplete"
    : phases.some((phase) => phase.status === "failed") || execution.admission.status === "rejected" ? "rejected" : "admitted";
  const transitionReceipts: GrowthReport["transitionReceipts"] = verdict === "admitted" && execution.comparison.status === "complete" && authority.status === "verified"
    ? [{ before: execution.comparison.before, after: execution.comparison.after, decisions: execution.decisionDigests,
      transitions: execution.admission.admittedTransitions, trustedRunRef: authority.runRef }] : [];
  return { contractRevision: "foundation:sdk-growth:c0:5", policyVersion: "foundation:sdk-growth:policy:1",
    repository: execution.observation.identity.repository, tool: execution.observation.identity.tool,
    trustedBase: execution.baseReference, candidate, released, authority, coverage,
    trustedBaseComparison: execution.comparison,
    releasedComparison, transitionReceipts, phases, verdict,
    releaseEligible: verdict === "admitted" && execution.compatibility.status === "complete" };
}

function hasQualification(row: SdkGrowthAdmissionExecution["released"][number],
  authority: SdkGrowthAdmissionExecution["authority"]): boolean {
  const value = row.qualification as { readonly receiptDigest?: unknown } | null | undefined;
  return authority.status === "verified" && value !== undefined && value !== null
    && typeof value.receiptDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.receiptDigest)
    && value.receiptDigest === authority.receiptDigest;
}

function selectPackageObservation(aggregate: import("../model/growth-observation.js").GrowthSurfaceObservation,
  packageName: string): import("../model/growth-observation.js").GrowthSurfaceObservation {
  return { ...aggregate,
    coverage: aggregate.coverage.filter((entry) => entry.packageName === packageName),
    entries: aggregate.entries.filter((entry) => entry.coordinate.packageName === packageName) };
}

function compareReleased(execution: SdkGrowthAdmissionExecution, fingerprint: ChangeFingerprint): GrowthComparison {
  const surface = execution.observation.surface;
  const rows = growthUniqueSorted(execution.released, (row) => row.packageName);
  if (surface.status !== "available" || rows.length === 0 || rows.some((row) => row.evidence.kind === "released"
    ? row.observation?.status !== "available" || !hasQualification(row, execution.authority)
    : row.evidence.history.status !== "available" || !hasQualification(row, execution.authority))) {
    return { status: "incomplete", reasons: ["growth-released-aggregate-comparison-unavailable"], findings: [] };
  }
  const candidateCoverage = new Map(surface.value.coverage.map((entry) => [entry.packageName, entry]));
  const missing = rows.filter((row) => !candidateCoverage.has(row.packageName));
  if (missing.length > 0) {
    return { status: "incomplete", reasons: missing.map((row) => `${row.packageName}:removed-package-compatibility-unavailable`), findings: [] };
  }
  const candidateEntries = new Map<string, typeof surface.value.entries[number][]>();
  for (const entry of surface.value.entries) {
    const values = candidateEntries.get(entry.coordinate.packageName) ?? [];
    values.push(entry); candidateEntries.set(entry.coordinate.packageName, values);
  }
  const before = rows.map((row) => {
    if (row.evidence.kind === "initial-unreleased") {
      return normalizeGrowthObservation({ ...surface.value, coverage: [candidateCoverage.get(row.packageName)!], entries: [] });
    }
    if (row.observation?.status !== "available") { throw new Error("Validated released observation disappeared."); }
    return normalizeGrowthObservation(selectPackageObservation(row.observation.value, row.packageName));
  });
  const comparisons = before.map((value, index) => {
    const packageName = rows[index]!.packageName;
    const candidate = normalizeGrowthObservation({ ...surface.value, coverage: [candidateCoverage.get(packageName)!],
      entries: candidateEntries.get(packageName) ?? [] });
    return compareGrowthSurfaces({ trustedBefore: { status: "available", value },
      candidateAfter: { status: "available", value: candidate } }, fingerprint);
  });
  const transitions = growthUniqueSorted(comparisons.flatMap((comparison) => comparison.status === "complete" ? comparison.transitions : comparison.findings),
    (entry) => growthCanonicalJson(entry.coordinate));
  if (comparisons.some((comparison) => comparison.status === "incomplete")) {
    return { status: "incomplete", reasons: ["growth-released-package-comparison-incomplete"], findings: transitions };
  }
  return { status: "complete", before: hashGrowthPayload(rows.map((row, index) => row.evidence.kind === "initial-unreleased"
      ? { packageName: row.packageName, kind: row.evidence.kind, history: row.evidence.history }
      : before[index]), fingerprint),
    after: hashGrowthPayload([normalizeGrowthObservation(surface.value)], fingerprint), transitions };
}

function projectAuthority(authority: SdkGrowthAdmissionExecution["authority"]): GrowthReport["authority"] {
  if (authority.status === "unverified") { return authority; }
  if (!/^sha256:[a-f0-9]{64}$/u.test(authority.receiptDigest)) {
    return { status: "unverified", reasons: ["growth-authority-receipt-digest-unavailable"] };
  }
  return authority.workflowRef?.trim() !== undefined && authority.workflowRef.trim() !== ""
      && authority.runRef?.trim() !== undefined && authority.runRef.trim() !== ""
    ? { status: "verified", workflowRef: authority.workflowRef, runRef: authority.runRef, receiptDigest: authority.receiptDigest }
    : { status: "unverified", reasons: ["growth-workflow-and-run-reference-unavailable"] };
}

function reportCoverage(execution: SdkGrowthAdmissionExecution, decisionComplete: boolean): GrowthCoverage[] {
  const base = execution.baseSurface.status === "available" ? execution.baseSurface.value.coverage : [];
  const candidate = execution.observation.surface.status === "available" ? execution.observation.surface.value.coverage : [];
  const names = [...new Set([...base, ...candidate, ...execution.released].map((row) => row.packageName))].toSorted();
  const baseByPackage = new Map(base.map((entry) => [entry.packageName, entry]));
  const candidateByPackage = new Map(candidate.map((entry) => [entry.packageName, entry]));
  const rank = { complete: 0, limited: 1, unsupported: 2, unavailable: 3 };
  return names.map((name) => {
    const previous = baseByPackage.get(name), current = candidateByPackage.get(name);
    const row = current ?? previous ?? { packageName: name, classification: "governed" as const,
      dimensions: growthDimensions.map((dimension) => ({ dimension, status: "unavailable" as const,
        reasons: ["candidate:package-outside-observed-topology"] })) };
    const beforeByDimension = new Map(previous?.dimensions.map((entry) => [entry.dimension, entry]));
    const afterByDimension = new Map(current?.dimensions.map((entry) => [entry.dimension, entry]));
    return { ...row, dimensions: row.dimensions.map((dimension) => {
      if (dimension.dimension === "decision") {
        return { ...dimension, status: decisionComplete ? "complete" : "unavailable", reasons: [decisionComplete ? "growth-decision-set-evaluated" : "growth-owner-and-run-authority-unverified"] };
      }
      const before = beforeByDimension.get(dimension.dimension);
      const after = afterByDimension.get(dimension.dimension);
      if (after === undefined) { return { ...dimension, status: "unavailable", reasons: ["candidate:package-outside-observed-topology"] }; }
      if (before === undefined) { return dimension; }
      return { ...dimension, status: rank[before.status] > rank[after.status] ? before.status : after.status,
        reasons: [...before.reasons.map((reason) => `trusted-base:${reason}`), ...after.reasons.map((reason) => `candidate:${reason}`)].toSorted() };
    }) };
  });
}

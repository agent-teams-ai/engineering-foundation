import { compareGrowthSurfaces, hashGrowthPayload } from "./compare-growth-surfaces.js";
import type { GrowthComparison } from "../model/growth-admission.js";
import type { SdkGrowthAdmissionExecution } from "../use-cases/admit-sdk-growth.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
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

function compareReleased(execution: SdkGrowthAdmissionExecution, fingerprint: ChangeFingerprint): GrowthComparison {
  const surface = execution.observation.surface;
  const rows = growthUniqueSorted(execution.released, (row) => row.packageName);
  if (surface.status !== "available" || rows.length === 0 || rows.some((row) => row.evidence.kind === "released"
    ? row.observation?.status !== "available"
    : row.evidence.history.status !== "available" || projectAuthority(execution.authority).status !== "verified")) {
    return { status: "incomplete", reasons: ["growth-released-aggregate-comparison-unavailable"], findings: [] };
  }
  const before = rows.map((row) => {
    if (row.evidence.kind === "initial-unreleased") {
      // Available history is verified by the context port. Derive an empty
      // comparison side, never a released ObservationRef or a v1 snapshot.
      return normalizeGrowthObservation({ ...surface.value, entries: [] });
    }
    if (row.observation?.status !== "available") { throw new Error("Validated released observation disappeared."); }
    return normalizeGrowthObservation(row.observation.value);
  });
  const comparisons = before.map((value, index) => {
    const packageName = rows[index]!.packageName;
    const select = (aggregate: typeof value) => ({ ...aggregate,
      coverage: aggregate.coverage.filter((row) => row.packageName === packageName),
      entries: aggregate.entries.filter((row) => row.coordinate.packageName === packageName) });
    return compareGrowthSurfaces({ trustedBefore: { status: "available", value: select(value) },
      candidateAfter: { status: "available", value: select(surface.value) } }, fingerprint);
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
  return authority.status === "unverified" ? authority
    : authority.workflowRef?.trim() !== undefined && authority.workflowRef.trim() !== ""
      && authority.runRef?.trim() !== undefined && authority.runRef.trim() !== ""
      ? { status: "verified", workflowRef: authority.workflowRef, runRef: authority.runRef, receiptDigest: authority.receiptDigest }
      : { status: "unverified", reasons: ["growth-workflow-and-run-reference-unavailable"] };
}

function reportCoverage(execution: SdkGrowthAdmissionExecution, decisionComplete: boolean): GrowthCoverage[] {
  const base = execution.baseSurface.status === "available" ? execution.baseSurface.value.coverage : [];
  const candidate = execution.observation.surface.status === "available" ? execution.observation.surface.value.coverage : [];
  const names = [...new Set([...base, ...candidate].map((row) => row.packageName))].toSorted();
  const rank = { complete: 0, limited: 1, unsupported: 2, unavailable: 3 };
  return names.map((name) => {
    const previous = base.find((entry) => entry.packageName === name), current = candidate.find((entry) => entry.packageName === name);
    const row = current ?? previous!;
    return { ...row, dimensions: row.dimensions.map((dimension) => {
      if (dimension.dimension === "decision") {
        return { ...dimension, status: decisionComplete ? "complete" : "unavailable", reasons: [decisionComplete ? "growth-decision-set-evaluated" : "growth-owner-and-run-authority-unverified"] };
      }
      const before = previous?.dimensions.find((entry) => entry.dimension === dimension.dimension);
      const after = current?.dimensions.find((entry) => entry.dimension === dimension.dimension);
      if (before === undefined || after === undefined) { return dimension; }
      return { ...dimension, status: rank[before.status] > rank[after.status] ? before.status : after.status,
        reasons: [...before.reasons.map((reason) => `trusted-base:${reason}`), ...after.reasons.map((reason) => `candidate:${reason}`)].toSorted() };
    }) };
  });
}

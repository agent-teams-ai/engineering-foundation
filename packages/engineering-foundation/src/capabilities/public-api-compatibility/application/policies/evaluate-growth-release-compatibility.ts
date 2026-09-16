// Runtime evidence may violate TypeScript literal types; retain fail-closed checks.
import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type { GrowthCompatibilityPackage, GrowthEvidence } from "../model/growth-observation.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { GrowthReleasedPackage } from "../model/growth-admission-context.js";
import type { PublicApiSnapshot } from "../model/public-api.js";
import type { AcceptedDecisionEvidence } from "../ports/accepted-decision-evidence.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { growthUniqueSorted } from "./normalize-growth-observation.js";
import { classifyPublicApiChange, evaluatePublicApiCompatibility } from "./evaluate-public-api-compatibility.js";
import { isApprovedBreakingChangeAccepted } from "./accepted-breaking-change.js";

export interface GrowthReleaseCompatibilityResult {
  readonly status: "complete" | "rejected" | "incomplete";
  readonly diagnostics: readonly FoundationDiagnostic[];
  readonly reasons: readonly string[];
}
function compareBranch(row: GrowthReleasedPackage, released: PublicApiSnapshot, current: PublicApiSnapshot,
  accepted: AcceptedDecisionEvidence, fingerprint: ChangeFingerprint): readonly FoundationDiagnostic[] {
  if (row.releaseEvidence.status !== "available") { throw new GrowthObservationInvariantError("growth-release-evidence-unavailable"); }
  const change = classifyPublicApiChange(released, current, fingerprint);
  const approval = row.policy.approvedBreakingChanges.find((entry) => entry.fingerprint === change.fingerprint);
  return evaluatePublicApiCompatibility({ policy: row.policy, released, current, change,
    releaseEvidence: row.releaseEvidence.value,
    acceptedDecision: approval === undefined ? undefined : isApprovedBreakingChangeAccepted(approval, accepted) });
}
function assertBranch(snapshot: GrowthEvidence<PublicApiSnapshot>, packageName: string, extractor: string): void {
  if (snapshot.status === "available" && (snapshot.value.packageName !== packageName
    || (snapshot.value.schemaVersion as unknown) !== 1 || snapshot.value.extractorVersion !== extractor)) {
    throw new GrowthObservationInvariantError("growth-compatibility-provenance-mismatch");
  }
}
function evaluateInitialUnreleased(input: {
  readonly row: GrowthReleasedPackage;
  readonly candidate: GrowthCompatibilityPackage;
  readonly extractorVersion: string;
  readonly authorityReceiptDigest: string | undefined;
  readonly reasons: string[];
}): void {
  if (input.row.evidence.kind !== "initial-unreleased") { throw new GrowthObservationInvariantError("growth-release-kind-mismatch"); }
  if (input.row.evidence.history.status !== "available" || input.row.evidence.qualification === undefined
    || input.row.evidence.qualification.receiptDigest !== input.authorityReceiptDigest) {
    input.reasons.push(`${input.row.packageName}:initial-unreleased-proof-not-qualified`); return;
  }
  if (input.row.releaseEvidence.status !== "available") { input.reasons.push(`${input.row.packageName}:release-evidence-unavailable`); return; }
  for (const branch of ["typed", "artifact"] as const) {
    const next = input.candidate[branch].snapshot;
    const extractor = branch === "typed" ? input.extractorVersion : "package-artifact-inventory/1";
    assertBranch(next, input.row.packageName, extractor);
    if (next.status !== "available") { input.reasons.push(`${input.row.packageName}:${branch}:compatibility-evidence-unavailable`); }
    else if (next.value.packageVersion !== input.row.releaseEvidence.value.packageVersion) {
      throw new GrowthObservationInvariantError("growth-release-version-mismatch");
    }
  }
}

/** Existing v1 comparator and SemVer policy on each original snapshot branch.
 * An initial history value needs the trusted S3 adapter's receipt qualification.
 * It proves absence of published compatibility obligations; it does
 * not synthesize a v1 baseline or waive first-surface admission. */
export function evaluateGrowthReleaseCompatibility(input: {
  readonly current: readonly GrowthCompatibilityPackage[];
  readonly released: readonly GrowthReleasedPackage[];
  readonly extractorVersion: string;
  readonly acceptedDecisions: AcceptedDecisionEvidence;
  readonly authorityReceiptDigest?: string;
}, fingerprint: ChangeFingerprint): GrowthReleaseCompatibilityResult {
  const current = growthUniqueSorted(input.current, (entry) => entry.packageName);
  const released = growthUniqueSorted(input.released, (entry) => entry.packageName);
  const diagnostics: FoundationDiagnostic[] = [], reasons: string[] = [];
  if (current.length === 0) { reasons.push("growth-compatibility-topology-unavailable"); }
  for (const row of released) {
    if (row.policy.packageName !== row.packageName) { throw new GrowthObservationInvariantError("growth-release-policy-package-mismatch"); }
    const candidate = current.find((entry) => entry.packageName === row.packageName);
    if (candidate === undefined) { reasons.push(`${row.packageName}:removed-package-compatibility-unavailable`); continue; }
    if (row.evidence.kind === "initial-unreleased") {
      evaluateInitialUnreleased({ row, candidate, extractorVersion: input.extractorVersion,
        authorityReceiptDigest: input.authorityReceiptDigest, reasons });
      continue;
    }
    if (row.releaseEvidence.status !== "available") { reasons.push(`${row.packageName}:release-evidence-unavailable`); continue; }
    if (row.releaseEvidence.value.packageName !== row.packageName) { throw new GrowthObservationInvariantError("growth-release-evidence-package-mismatch"); }
    for (const branch of ["typed", "artifact"] as const) {
      const previous = row.evidence[branch], next = candidate[branch].snapshot;
      const extractor = branch === "typed" ? input.extractorVersion : "package-artifact-inventory/1";
      assertBranch(previous, row.packageName, extractor); assertBranch(next, row.packageName, extractor);
      if (previous.status !== "available" || next.status !== "available") {
        reasons.push(`${row.packageName}:${branch}:compatibility-evidence-unavailable`); continue;
      }
      if (next.value.packageVersion !== row.releaseEvidence.value.packageVersion) {
        throw new GrowthObservationInvariantError("growth-release-version-mismatch");
      }
      diagnostics.push(...compareBranch(row, previous.value, next.value, input.acceptedDecisions, fingerprint));
    }
  }
  for (const row of current) {
    if (!released.some((entry) => entry.packageName === row.packageName)) { reasons.push(`${row.packageName}:released-history-unavailable`); }
  }
  return { status: reasons.length !== 0 ? "incomplete" : diagnostics.length !== 0 ? "rejected" : "complete", diagnostics, reasons };
}

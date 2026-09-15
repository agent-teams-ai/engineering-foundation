// Runtime evidence may violate TypeScript literal types; retain fail-closed checks.
import type { GrowthAdmissionDiagnostic, GrowthAdmissionResult, GrowthComparison, GrowthDecision, GrowthDecisionAuthority, GrowthTransition } from "../model/growth-admission.js";
import { growthPolicyVersion } from "../model/growth-admission.js";
import type { GrowthDigest } from "../model/growth-observation.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { compareGrowthStrings, growthCanonicalJson, growthUniqueSorted } from "./normalize-growth-observation.js";
import { growthGroupFingerprint, growthTransitionFingerprint, hashGrowthPayload } from "./compare-growth-surfaces.js";
import { isGrowthDecision } from "./validate-growth-decision.js";

/** One decision normalization for both exact matching and evidence binding. */
function normalizeGrowthDecision(value: unknown): GrowthDecision {
  if (!isGrowthDecision(value)) { throw new GrowthObservationInvariantError("growth-decision-malformed"); }
  return { ...value,
    transitions: growthUniqueSorted(value.transitions, (entry) => entry),
    coordinates: growthUniqueSorted(value.coordinates, growthCanonicalJson),
    consumerEvidenceRefs: growthUniqueSorted(value.consumerEvidenceRefs, growthCanonicalJson) };
}
export function growthDecisionDigest(decision: GrowthDecision, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "foundation:sdk-growth:decision:1", payload: normalizeGrowthDecision(decision) }, fingerprint);
}
function validateTransitions(transitions: readonly GrowthTransition[], fingerprint: ChangeFingerprint): readonly GrowthTransition[] {
  if (transitions.length > 100_000) { throw new GrowthObservationInvariantError("growth-transition-budget-exhausted"); }
  const result = growthUniqueSorted(transitions, (entry) => growthCanonicalJson(entry.coordinate));
  growthUniqueSorted(result, (entry) => entry.fingerprint);
  for (const entry of result) {
    if ((entry.policyVersion as unknown) !== growthPolicyVersion || entry.fingerprint !== growthTransitionFingerprint(entry, fingerprint)) {
      throw new GrowthObservationInvariantError("growth-transition-fingerprint-mismatch");
    }
  }
  return result;
}

function exactDecisionDiagnostics(decision: GrowthDecision, actual: ReadonlyMap<GrowthDigest, GrowthTransition>, claimed: ReadonlySet<GrowthDigest>, fingerprint: ChangeFingerprint): readonly GrowthAdmissionDiagnostic[] {
    const diagnostics: GrowthAdmissionDiagnostic[] = [];
    const add = (code: GrowthAdmissionDiagnostic["code"], subject: string, remediation: string): void => { diagnostics.push({ code, subject, remediation }); };
    const subject = decision.decisionId;
    if (decision.transitions.some((entry) => !actual.has(entry))) {
      add("growth-decision-stale", subject, "Reapprove the exact observed before/after transitions; remove stale or extra transition claims.");
    }
    const selected = decision.transitions.flatMap((entry) => { const value = actual.get(entry); return value === undefined ? [] : [value]; });
    const coordinates = growthUniqueSorted(selected.map((entry) => entry.coordinate), growthCanonicalJson);
    if (growthCanonicalJson(coordinates) !== growthCanonicalJson(decision.coordinates)) {
      add("growth-decision-coordinate-mismatch", subject, "Make coordinates equal exactly the decision's observed transition coordinate set.");
    }
    if (growthGroupFingerprint(decision.transitions, fingerprint) !== decision.changeFingerprint) {
      add("growth-decision-fingerprint-mismatch", subject, "Bind approval to the group digest of the exact sorted atomic fingerprints and current policy version.");
    }
    if (decision.transitions.some((entry) => claimed.has(entry))) {
      add("growth-decision-overlap", subject, "Assign each transition to exactly one decision.");
    }
    return diagnostics;
}

function decisionBudgetExhausted(): GrowthAdmissionResult {
  return { status: "incomplete", admittedTransitions: [], releaseEligible: false,
    diagnostics: [{ code: "growth-decision-budget-exhausted", subject: "decisions",
      remediation: "Supply at most 10000 decisions and 100000 total transition claims." }] };
}

/** Count raw claims before validation, without copying or visiting claim elements. */
function withinDecisionBudget(rawDecisions: readonly unknown[]): boolean {
  if (rawDecisions.length > 10_000) { return false; }
  let remaining = 100_000;
  for (const raw of rawDecisions) {
    if (raw !== null && typeof raw === "object" && "transitions" in raw && Array.isArray(raw.transitions)) {
      if (raw.transitions.length > remaining) { return false; }
      remaining -= raw.transitions.length;
    }
  }
  return true;
}

/** Normalize the full bounded set before claims; duplicate IDs have no authority. */
function prepareDecisions(rawDecisions: readonly unknown[], diagnostics: GrowthAdmissionDiagnostic[]): readonly GrowthDecision[] | undefined {
  if (!withinDecisionBudget(rawDecisions)) { return undefined; }
  const decisions: GrowthDecision[] = [];
  const counts = new Map<string, number>();
  for (const raw of rawDecisions) {
    let decision: GrowthDecision;
    try { decision = normalizeGrowthDecision(raw); }
    catch {
      diagnostics.push({ code: "growth-decision-malformed", subject: "decision",
        remediation: "Supply a closed decision with unique transitions, coordinates, consumer evidence, owner and rationale." });
      continue;
    }
    decisions.push(decision);
    counts.set(decision.decisionId, (counts.get(decision.decisionId) ?? 0) + 1);
  }
  for (const [id, occurrences] of counts) {
    if (occurrences > 1) { diagnostics.push({ code: "growth-decision-duplicate", subject: id,
      remediation: "Use one exact decision record per decision ID." }); }
  }
  return decisions.filter((decision) => counts.get(decision.decisionId) === 1)
    .toSorted((left, right) => compareGrowthStrings(left.decisionId, right.decisionId));
}

/** Exact PR admission only. The independent released policy's failure is final;
 * authority must bind the entire normalized decision, not merely its ID. */
export function evaluateGrowthAdmission(input: {
  readonly comparison: GrowthComparison;
  readonly decisions: readonly unknown[];
  readonly authority: readonly GrowthDecisionAuthority[];
  readonly compatibility: "complete" | "rejected" | "incomplete";
}, fingerprint: ChangeFingerprint): GrowthAdmissionResult {
  const diagnostics: GrowthAdmissionDiagnostic[] = [];
  const add = (code: GrowthAdmissionDiagnostic["code"], subject: string, remediation: string): void => {
    diagnostics.push({ code, subject, remediation });
  };
  let incomplete = input.comparison.status === "incomplete" || input.compatibility === "incomplete";
  if (incomplete) { add("growth-comparison-incomplete", "comparison", "Supply complete trusted-base, candidate and released compatibility evidence; do not substitute empty baselines."); }
  if (input.compatibility === "rejected") { add("growth-compatibility-rejected", "released", "Satisfy the existing release compatibility, SemVer and removal obligations independently of growth admission."); }
  const transitions = validateTransitions(input.comparison.status === "complete" ? input.comparison.transitions : input.comparison.findings, fingerprint);
  const actual = new Map(transitions.map((entry) => [entry.fingerprint, entry]));
  const claimed = new Set<GrowthDigest>(), admitted = new Set<GrowthDigest>();
  const decisions = prepareDecisions(input.decisions, diagnostics);
  if (decisions === undefined) { return decisionBudgetExhausted(); }
  const authorities = growthUniqueSorted(input.authority, (entry) => entry.decisionId);
  for (const decision of decisions) {
    const subject = decision.decisionId;
    const exactDiagnostics = exactDecisionDiagnostics(decision, actual, claimed, fingerprint);
    diagnostics.push(...exactDiagnostics);
    let valid = exactDiagnostics.length === 0;
    for (const entry of decision.transitions) { claimed.add(entry); }
    const authority = authorities.find((entry) => entry.decisionId === subject);
    if (authority?.ownerRef !== decision.ownerRef || authority.decisionDigest !== growthDecisionDigest(decision, fingerprint)) {
      add("growth-owner-evidence-unavailable", subject, "Supply independently validated owner evidence binding this complete decision and its exact transitions."); incomplete = true; valid = false;
    }
    if (valid) { for (const entry of decision.transitions) { admitted.add(entry); } }
  }
  for (const transition of transitions) {
    if (!claimed.has(transition.fingerprint)) {
      add("growth-transition-unadmitted", transition.fingerprint, "Provide an owner-approved decision for this exact coordinate, before value and after value.");
    }
  }
  const ordered = diagnostics.toSorted((left, right) => {
    const a = growthCanonicalJson(left), b = growthCanonicalJson(right);
    return compareGrowthStrings(a, b);
  });
  const status = admissionStatus(incomplete, ordered);
  return { status, admittedTransitions: status === "admitted" ? growthUniqueSorted([...admitted], (entry) => entry) : [], diagnostics: ordered, releaseEligible: false };
}

function admissionStatus(incomplete: boolean, diagnostics: readonly GrowthAdmissionDiagnostic[]): GrowthAdmissionResult["status"] {
  if (incomplete) { return "incomplete"; }
  return diagnostics.length === 0 ? "admitted" : "rejected";
}

// Runtime evidence may violate TypeScript literal types; retain fail-closed checks.
import type { GrowthCoordinate, GrowthDigest, GrowthEvidence, GrowthSurfaceObservation } from "../model/growth-observation.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { GrowthComparison, GrowthTransition, GrowthValueRef } from "../model/growth-admission.js";
import { growthPolicyVersion } from "../model/growth-admission.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { growthCanonicalJson, growthObservationDigest, growthUniqueSorted, normalizeGrowthObservation } from "./normalize-growth-observation.js";
import { assertGrowthCoordinateShape } from "./validate-growth-observation.js";

function assertDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) { throw new GrowthObservationInvariantError("invalid-growth-digest"); }
}
export function hashGrowthPayload(payload: unknown, fingerprint: ChangeFingerprint): GrowthDigest {
  const digest = `sha256:${fingerprint.sha256(growthCanonicalJson(payload))}` as const;
  assertDigest(digest);
  return digest;
}
function validateValue(value: GrowthValueRef): void {
  if (value.state === "present") {
    if (Object.keys(value).length !== 2) { throw new GrowthObservationInvariantError("invalid-growth-value"); }
    assertDigest(value.digest);
  } else if ((value.state as unknown) !== "absent" || Object.keys(value).length !== 1) {
    throw new GrowthObservationInvariantError("invalid-growth-value");
  }
}
/** Policy semantics are part of the domain-separated payload, not the digest
 * adapter. Admission selects the supported version; this primitive can prove
 * that another semantics version has a different identity. */
export function growthTransitionFingerprint(input: {
  readonly coordinate: GrowthCoordinate;
  readonly before: GrowthValueRef;
  readonly after: GrowthValueRef;
  readonly policyVersion: string;
}, fingerprint: ChangeFingerprint): GrowthDigest {
  assertGrowthCoordinateShape(input.coordinate);
  validateValue(input.before); validateValue(input.after);
  if (input.policyVersion.trim().length === 0) { throw new GrowthObservationInvariantError("invalid-growth-policy-version"); }
  if (growthCanonicalJson(input.before) === growthCanonicalJson(input.after)) {
    throw new GrowthObservationInvariantError("growth-transition-no-change");
  }
  return hashGrowthPayload({ domain: "foundation:sdk-growth:transition:1", policyVersion: input.policyVersion,
    coordinate: input.coordinate, before: input.before, after: input.after }, fingerprint);
}
export function growthGroupFingerprint(transitions: readonly GrowthDigest[], fingerprint: ChangeFingerprint,
  policyVersion: string = growthPolicyVersion): GrowthDigest {
  if (transitions.length > 100_000 || policyVersion.trim().length === 0) {
    throw new GrowthObservationInvariantError("invalid-growth-group");
  }
  transitions.forEach(assertDigest);
  return hashGrowthPayload({ domain: "foundation:sdk-growth:group:1", policyVersion,
    transitions: growthUniqueSorted(transitions, (value) => value) }, fingerprint);
}

function incompleteReasons(observation: GrowthSurfaceObservation, side: string): string[] {
  if (observation.coverage.length === 0) { return [`${side}:topology-unavailable`]; }
  return observation.coverage.flatMap((row) => [
    ...(row.classification === "private-only" ? [`${side}:${row.packageName}:private-classification-unqualified`] : []),
    ...row.dimensions
    .filter((entry) => entry.dimension !== "decision" && entry.status !== "complete")
    .map((entry) => `${side}:${row.packageName}:${entry.dimension}:${entry.status}`)]);
}

function deriveTransitions(before: GrowthSurfaceObservation, after: GrowthSurfaceObservation, beforeComplete: boolean, afterComplete: boolean, fingerprint: ChangeFingerprint): readonly GrowthTransition[] | undefined {
  const left = new Map(before.entries.map((entry) => [growthCanonicalJson(entry.coordinate), entry]));
  const right = new Map(after.entries.map((entry) => [growthCanonicalJson(entry.coordinate), entry]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].toSorted();
  const transitions: GrowthTransition[] = [];
  for (const key of keys) {
    const previous = left.get(key), candidate = right.get(key);
    if ((previous === undefined && !beforeComplete) || (candidate === undefined && !afterComplete)) { continue; }
    const coordinate = previous?.coordinate ?? candidate?.coordinate;
    if (coordinate === undefined) { throw new GrowthObservationInvariantError("growth-coordinate-unavailable"); }
    const beforeValue = previous?.value ?? { state: "absent" as const };
    const afterValue = candidate?.value ?? { state: "absent" as const };
    if (growthCanonicalJson(beforeValue) === growthCanonicalJson(afterValue)) { continue; }
    if (transitions.length === 100_000) { return undefined; }
    const transition = { coordinate, before: beforeValue, after: afterValue, policyVersion: growthPolicyVersion };
    transitions.push({ ...transition, fingerprint: growthTransitionFingerprint(transition, fingerprint) });
  }
  growthUniqueSorted(transitions, (transition) => transition.fingerprint);
  return transitions;
}

/** Compare immutable S1 aggregates, never a reference, decision, path or count.
 * Missing entries imply absence only when the entire comparison side proves
 * complete observation. Partial evidence can retain explicit two-sided facts. */
export function compareGrowthSurfaces(input: {
  readonly trustedBefore: GrowthEvidence<GrowthSurfaceObservation>;
  readonly candidateAfter: GrowthEvidence<GrowthSurfaceObservation>;
}, fingerprint: ChangeFingerprint): GrowthComparison {
  if (input.trustedBefore.status !== "available" || input.candidateAfter.status !== "available") {
    return { status: "incomplete", reasons: ["growth-observation-unavailable:retain-trusted-and-candidate-aggregates"], findings: [] };
  }
  const before = normalizeGrowthObservation(input.trustedBefore.value);
  const after = normalizeGrowthObservation(input.candidateAfter.value);
  const beforeReasons = incompleteReasons(before, "before"), afterReasons = incompleteReasons(after, "after");
  const reasons = [...beforeReasons, ...afterReasons];
  if (before.repository !== after.repository || before.tool.extractorVersion !== after.tool.extractorVersion
    || before.tool.version !== after.tool.version || before.tool.artifactDigest !== after.tool.artifactDigest) {
    reasons.push("growth-observer-or-repository-mismatch");
    return { status: "incomplete", reasons: growthUniqueSorted(reasons, (value) => value), findings: [] };
  }
  const transitions = deriveTransitions(before, after, beforeReasons.length === 0, afterReasons.length === 0, fingerprint);
  if (transitions === undefined) { return { status: "incomplete", reasons: ["growth-transition-budget-exhausted"], findings: [] }; }
  if (reasons.length !== 0) { return { status: "incomplete", reasons: growthUniqueSorted(reasons, (value) => value), findings: transitions }; }
  return { status: "complete", before: growthObservationDigest(before, fingerprint), after: growthObservationDigest(after, fingerprint), transitions };
}

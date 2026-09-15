import type { GrowthAdmissionResult, GrowthComparison } from "../model/growth-admission.js";
import type { GrowthContextRequest, GrowthInputContext } from "../model/growth-admission-context.js";
import type { GrowthCancellation, GrowthInvocation, GrowthObservationExecution } from "../model/growth-observation.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type { GrowthObservationPort } from "../ports/growth-observation.js";
import type { GrowthInputContextPort } from "../ports/growth-input-context.js";
import { compareGrowthSurfaces } from "../policies/compare-growth-surfaces.js";
import { evaluateGrowthAdmission } from "../policies/evaluate-growth-admission.js";
import { evaluateGrowthReleaseCompatibility } from "../policies/evaluate-growth-release-compatibility.js";
import type { GrowthReleaseCompatibilityResult } from "../policies/evaluate-growth-release-compatibility.js";
import { growthCanonicalJson, growthObservationReference, growthUniqueSorted, normalizeGrowthInvocation } from "../policies/normalize-growth-observation.js";
import { assertGrowthEvidence, validateGrowthExecution } from "../policies/validate-growth-execution.js";

function trustedReasons(context: GrowthInputContext, fingerprint: ChangeFingerprint): readonly string[] {
  assertGrowthEvidence(context.trustedBase); assertGrowthEvidence(context.trustedBaseReference); assertGrowthEvidence(context.retainedHistory);
  const reasons: string[] = [];
  if (context.authority.status === "verified" && !/^sha256:[a-f0-9]{64}$/u.test(context.authority.receiptDigest)) {
    throw new GrowthObservationInvariantError("growth-authority-receipt-invalid");
  }
  if (context.retainedHistory.status === "available" && !/^sha256:[a-f0-9]{64}$/u.test(context.retainedHistory.value.receiptDigest)) {
    throw new GrowthObservationInvariantError("growth-history-receipt-invalid");
  }
  if (context.authority.status !== "verified") { reasons.push("growth-authority-unverified"); }
  if (context.trustedBase.status !== "available" || context.trustedBaseReference.status !== "available") {
    reasons.push("growth-trusted-base-reference-unavailable"); return reasons;
  }
  const reference = growthObservationReference(context.trustedBase.value, fingerprint);
  if (growthCanonicalJson(reference) !== growthCanonicalJson(context.trustedBaseReference.value)) {
    throw new GrowthObservationInvariantError("growth-trusted-base-reference-mismatch");
  }
  if (context.retainedHistory.status !== "available") { reasons.push("growth-retained-history-unavailable"); }
  else if (context.retainedHistory.value.targetSurfaceDigest !== reference.surfaceDigest) {
    reasons.push("growth-retained-history-target-mismatch");
  }
  return reasons;
}

function releaseScopeReasons(context: GrowthInputContext, execution: GrowthObservationExecution): readonly string[] {
  if (context.trustedBase.status !== "available" || execution.surface.status !== "available") { return ["growth-release-topology-unavailable"]; }
  const packages = [...new Set([...context.trustedBase.value.coverage, ...execution.surface.value.coverage].map((row) => row.packageName))].toSorted();
  const released = growthUniqueSorted(context.released, (row) => row.packageName).map((row) => row.packageName);
  return growthCanonicalJson(packages) === growthCanonicalJson(released) ? [] : ["growth-release-topology-mismatch"];
}

export interface SdkGrowthAdmissionExecution {
  readonly admission: GrowthAdmissionResult;
  readonly comparison: GrowthComparison;
  readonly compatibility: GrowthReleaseCompatibilityResult;
  readonly released: GrowthInputContext["released"];
}

/** Internal, inactive S2 use case. One S1 observation is authoritative for both
 * comparisons. No CLI/config/report activation, persistence or release promotion.
 * The context boundary owns external verification; unavailable retained history
 * is never reconstructed from a candidate or an empty v1 baseline. */
export async function admitSdkGrowth(input: {
  readonly invocation: GrowthInvocation;
  readonly context: GrowthContextRequest;
  readonly cancellation: GrowthCancellation;
}, dependencies: {
  readonly observation: GrowthObservationPort;
  readonly context: GrowthInputContextPort;
  readonly fingerprint: ChangeFingerprint;
}): Promise<SdkGrowthAdmissionExecution> {
  const cancellation = input.cancellation;
  cancellation.throwIfCancelled();
  const invocation = structuredClone(normalizeGrowthInvocation(input.invocation));
  const request = structuredClone(input.context);
  try {
    const execution = structuredClone(await dependencies.observation.observe(structuredClone(invocation), cancellation));
    cancellation.throwIfCancelled();
    validateGrowthExecution(execution, invocation);
    const context = structuredClone(await dependencies.context.read(request, cancellation));
    cancellation.throwIfCancelled();
    const reasons = [...trustedReasons(context, dependencies.fingerprint), ...releaseScopeReasons(context, execution)];
    const observedComparison = compareGrowthSurfaces({ trustedBefore: context.trustedBase, candidateAfter: execution.surface }, dependencies.fingerprint);
    const comparison: GrowthComparison = reasons.length === 0 ? observedComparison : {
      status: "incomplete",
      reasons: growthUniqueSorted([...reasons, ...(observedComparison.status === "incomplete" ? observedComparison.reasons : [])], (reason) => reason),
      findings: observedComparison.status === "complete" ? observedComparison.transitions : observedComparison.findings
    };
    const compatibility = evaluateGrowthReleaseCompatibility({ current: execution.compatibilitySnapshots, released: context.released,
      extractorVersion: invocation.tool.extractorVersion, acceptedDecisions: context.acceptedBreakingDecisions }, dependencies.fingerprint);
    const ownerEvidence = context.acceptedBreakingDecisions.growthDecisionAuthority;
    const authority = context.authority.status === "verified" && ownerEvidence?.status === "available" ? ownerEvidence.value : [];
    const admission = evaluateGrowthAdmission({ comparison, decisions: context.decisions, authority, compatibility: compatibility.status }, dependencies.fingerprint);
    cancellation.throwIfCancelled();
    return { admission, comparison, compatibility, released: context.released };
  } catch (error) {
    cancellation.throwIfCancelled();
    throw error;
  }
}

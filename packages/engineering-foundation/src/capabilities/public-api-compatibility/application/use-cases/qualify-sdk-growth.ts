import type { GrowthAuthorityReceipt } from "../model/growth-authority.js";
import { growthAuthoritySchemaVersion } from "../model/growth-authority.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { GrowthAuthorityPort } from "../ports/growth-authority.js";
import type { ResolvedGrowthInputContextPort } from "../ports/growth-input-context.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { growthReportAuthorityDigests } from "../policies/validate-growth-authority.js";
import { executeSdkGrowth } from "./check-sdk-growth.js";

export interface QualifiedSdkGrowthExecution extends Awaited<ReturnType<typeof executeSdkGrowth>> {
  readonly receipt?: GrowthAuthorityReceipt;
}

/** Coordinates the already-existing check with authenticated completion.
 * Report publication precedes completion so the receipt binds finalized bytes. */
export async function qualifySdkGrowth(
  input: Parameters<typeof executeSdkGrowth>[0],
  dependencies: Parameters<typeof executeSdkGrowth>[1] & {
    readonly context: ResolvedGrowthInputContextPort;
    readonly authority: GrowthAuthorityPort;
    readonly fingerprint: ChangeFingerprint;
  }
): Promise<QualifiedSdkGrowthExecution> {
  const execution = await executeSdkGrowth(input, dependencies);
  if (execution.report === undefined || execution.reportDigest === undefined || execution.reportByteLength === undefined) {
    return execution;
  }
  const resolved = dependencies.context.resolution();
  const digests = growthReportAuthorityDigests(execution.report, dependencies.fingerprint);
  if (digests.coverageDigest !== resolved.grant.requiredCoverageDigest) {
    throw new GrowthObservationInvariantError("growth-authority-coverage-mismatch");
  }
  const cancellation = { ...(input.signal === undefined ? {} : { signal: input.signal }),
    throwIfCancelled() {
      if (input.signal?.aborted === true) { throw input.signal.reason; }
    } };
  const completion = {
    schemaVersion: growthAuthoritySchemaVersion,
    kind: "completion" as const,
    grantId: resolved.grant.grantId,
    grantDigest: resolved.grantDigest,
    requestDigest: resolved.requestDigest,
    binding: resolved.grant.binding,
    reportDigest: execution.reportDigest,
    reportByteLength: execution.reportByteLength,
    coverageDigest: digests.coverageDigest,
    phasesDigest: digests.phasesDigest,
    verdict: execution.report.verdict,
    releaseEligible: execution.report.releaseEligible,
    publication: "finalized" as const,
    promotion: { kind: "none" as const }
  };
  const receipt = await dependencies.authority.complete(completion, cancellation);
  if (execution.report.verdict === "admitted" && (receipt.qualification !== "qualified" || !receipt.releaseEligible)) {
    throw new GrowthObservationInvariantError("growth-authority-qualified-receipt-required");
  }
  return { ...execution, receipt };
}

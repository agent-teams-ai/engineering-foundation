import type { GrowthComparison } from "./growth-admission.js";
import type { GrowthCoverage, GrowthDigest, GrowthEvidence, GrowthInvocation, GrowthObservationReference } from "./growth-observation.js";

export const growthReportPhases = ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"] as const;
export interface GrowthReport {
  readonly contractRevision: "foundation:sdk-growth:c0:5";
  readonly policyVersion: "foundation:sdk-growth:policy:1";
  readonly repository: string;
  readonly trustedBase: GrowthEvidence<GrowthObservationReference>;
  readonly candidate: GrowthEvidence<GrowthObservationReference>;
  readonly released: readonly { readonly packageName: string; readonly evidence:
    | { readonly kind: "released"; readonly observation: GrowthEvidence<GrowthObservationReference> }
    | { readonly kind: "initial-unreleased"; readonly history: GrowthEvidence<GrowthDigest> } }[];
  readonly tool: GrowthInvocation["tool"];
  readonly authority:
    | { readonly status: "verified"; readonly workflowRef: string; readonly runRef: string; readonly receiptDigest: GrowthDigest }
    | { readonly status: "unverified"; readonly reasons: readonly string[] };
  readonly coverage: readonly GrowthCoverage[];
  readonly trustedBaseComparison: GrowthComparison;
  readonly releasedComparison: GrowthComparison;
  readonly transitionReceipts: readonly { readonly before: GrowthDigest; readonly after: GrowthDigest;
    readonly decisions: readonly GrowthDigest[]; readonly transitions: readonly GrowthDigest[]; readonly trustedRunRef: string }[];
  readonly phases: readonly { readonly name: typeof growthReportPhases[number]; readonly status: "complete" | "failed" | "unavailable" }[];
  readonly verdict: "admitted" | "rejected" | "incomplete";
  readonly releaseEligible: boolean;
}

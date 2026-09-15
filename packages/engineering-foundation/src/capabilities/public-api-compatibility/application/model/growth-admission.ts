import type { GrowthCoordinate, GrowthDigest } from "./growth-observation.js";

/** Internal S2 data only. Neither a decision file nor this model proves approval. */
export const growthPolicyVersion = "foundation:sdk-growth:policy:1" as const;
export type GrowthValueRef =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly digest: GrowthDigest };
export interface GrowthTransition {
  readonly coordinate: GrowthCoordinate;
  readonly before: GrowthValueRef;
  readonly after: GrowthValueRef;
  readonly policyVersion: typeof growthPolicyVersion;
  readonly fingerprint: GrowthDigest;
}
interface GrowthConsumerEvidenceRef {
  readonly useCase: string;
  readonly repository: string;
  readonly source: {
    readonly tree: string;
    readonly contentDigest: GrowthDigest;
    readonly commit: string | null;
  };
  readonly artifactDigest: GrowthDigest | null;
}
export interface GrowthDecision {
  readonly contractRevision: "foundation:sdk-growth:c0:5";
  readonly decisionId: string;
  readonly ownerRef: string;
  readonly stability: "development" | "experimental" | "supported";
  readonly transitions: readonly GrowthDigest[];
  readonly coordinates: readonly GrowthCoordinate[];
  readonly changeFingerprint: GrowthDigest;
  readonly consumerEvidenceRefs: readonly GrowthConsumerEvidenceRef[];
  readonly exposureRationale: string;
  readonly compatibilityRationale: string;
  readonly lifecycle:
    | { readonly kind: "ordinary" }
    | {
      readonly kind: "shim" | "deprecation" | "removal";
      readonly replacement: string;
      readonly migration: string;
      readonly removalConditions: string;
    };
}

export type GrowthComparison =
  | {
    readonly status: "complete";
    readonly before: GrowthDigest;
    readonly after: GrowthDigest;
    readonly transitions: readonly GrowthTransition[];
  }
  | {
    readonly status: "incomplete";
    readonly reasons: readonly string[];
    readonly findings: readonly GrowthTransition[];
  };

export interface GrowthAdmissionDiagnostic {
  readonly code: "growth-decision-malformed" | "growth-decision-duplicate"
    | "growth-decision-stale" | "growth-decision-coordinate-mismatch"
    | "growth-decision-fingerprint-mismatch" | "growth-transition-unadmitted"
    | "growth-decision-overlap" | "growth-owner-evidence-unavailable"
    | "growth-decision-budget-exhausted" | "growth-comparison-incomplete" | "growth-compatibility-rejected";
  readonly subject: string;
  readonly remediation: string;
}

/** Validated authority supplied at the application boundary, never inferred
 * from a candidate Decision or an accepted ID alone. */
export interface GrowthDecisionAuthority {
  readonly decisionId: string;
  readonly ownerRef: string;
  readonly decisionDigest: GrowthDigest;
}
export interface GrowthAdmissionResult {
  readonly status: "admitted" | "rejected" | "incomplete";
  readonly admittedTransitions: readonly GrowthDigest[];
  readonly diagnostics: readonly GrowthAdmissionDiagnostic[];
  /** This internal PR policy never grants release authority. */
  readonly releaseEligible: false;
}

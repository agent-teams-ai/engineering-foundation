import type { GrowthDigest, GrowthEvidence, GrowthObservationReference, GrowthSurfaceObservation } from "./growth-observation.js";
import type { PackageReleaseEvidence, PublicApiPackagePolicy, PublicApiSnapshot } from "./public-api.js";
import type { AcceptedDecisionEvidence } from "../ports/accepted-decision-evidence.js";

export interface GrowthReleasedPackage {
  readonly packageName: string;
  readonly observation?: GrowthEvidence<GrowthSurfaceObservation>;
  readonly policy: PublicApiPackagePolicy;
  readonly releaseEvidence: GrowthEvidence<PackageReleaseEvidence>;
  /** Present only after trusted packed custody has qualified this row. */
  readonly qualification?: { readonly receiptDigest: GrowthDigest };
  readonly evidence:
    | { readonly kind: "released"; readonly typed: GrowthEvidence<PublicApiSnapshot>; readonly artifact: GrowthEvidence<PublicApiSnapshot> }
    | { readonly kind: "initial-unreleased"; readonly history: GrowthEvidence<GrowthDigest> };
}

/** Internal context from a trusted input boundary. No candidate observation or
 * candidate compatibility snapshot is accepted here. Available history denotes
 * a validated exact-target retained receipt, not a caller's initial flag. */
export interface GrowthInputContext {
  /** Only the authenticated v3 adapter supplies these exact grant qualifications. */
  readonly nonReleaseMetadataRoots?: readonly { readonly packageName: string; readonly receiptDigest: GrowthDigest }[];
  readonly trustedBase: GrowthEvidence<GrowthSurfaceObservation>;
  readonly trustedBaseReference: GrowthEvidence<GrowthObservationReference>;
  readonly retainedHistory: GrowthEvidence<{
    readonly targetSurfaceDigest: GrowthDigest;
    readonly receiptDigest: GrowthDigest;
  }>;
  readonly released: readonly GrowthReleasedPackage[];
  readonly decisions: readonly unknown[];
  readonly acceptedBreakingDecisions: AcceptedDecisionEvidence;
  readonly authority:
    | { readonly status: "verified"; readonly receiptDigest: GrowthDigest; readonly workflowRef?: string; readonly runRef?: string }
    | { readonly status: "unverified"; readonly reasons: readonly string[] };
}

export interface GrowthContextRequest {
  readonly trustedBasePath: string;
  readonly decisionsPath: string;
  readonly released: readonly ({ readonly packageName: string } & (
    | { readonly kind: "released"; readonly observationPath: string }
    | { readonly kind: "initial-unreleased"; readonly trustedHistoryPath: string }
  ))[];
}

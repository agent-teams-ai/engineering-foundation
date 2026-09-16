import type { GrowthDecisionAuthority } from "./growth-admission.js";
import type { GrowthContextRequest, GrowthInputContext } from "./growth-admission-context.js";
import type { GrowthDigest, GrowthInvocation, GrowthObservationReference, GrowthSurfaceObservation } from "./growth-observation.js";
import type { PackageReleaseEvidence, PublicApiSnapshot } from "./public-api.js";

export const growthAuthoritySchemaVersion = "reviewrouter:sdk-growth-authority:1" as const;
export const growthAuthorityRequiredPhases = ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"] as const;

export interface GrowthAuthorityRepository {
  readonly provider: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
}

export interface GrowthAuthorityOwnerEvidence extends GrowthDecisionAuthority {
  readonly authenticatedSubjectId: string;
  readonly authorizationEvidenceDigest: GrowthDigest;
  readonly approvalEvidenceDigest: GrowthDigest;
  readonly sourceBindingDigest: GrowthDigest;
}

export interface GrowthAuthoritySource {
  readonly commit: string;
  readonly tree: string;
}

export interface GrowthAuthorityTarget {
  readonly repository: GrowthAuthorityRepository;
  readonly pullRequestNumber: number;
  readonly head: GrowthAuthoritySource;
  readonly base: GrowthAuthoritySource;
  readonly mergeBase: GrowthAuthoritySource;
  readonly evaluation: GrowthAuthoritySource;
  readonly evaluationKind: "head" | "merge-result" | "release-preimage";
}

export interface GrowthAuthorityBinding {
  readonly invocation: GrowthInvocation;
  readonly target: GrowthAuthorityTarget;
  readonly verifier: {
    readonly identity: string;
    readonly immutableRevision: string;
    readonly artifactDigest: GrowthDigest;
  };
  readonly tool: {
    readonly packageName: "@agent-teams/engineering-foundation";
    readonly version: string;
    readonly archiveDigest: GrowthDigest;
    readonly archiveIntegrity: string;
    readonly distributionDigest: GrowthDigest;
    readonly extractorVersion: string;
  };
  readonly policy: {
    readonly contractRevision: "foundation:sdk-growth:c0:5";
    readonly policyVersion: "foundation:sdk-growth:policy:1";
    readonly enrollmentRevision: string;
    readonly configurationDigest: GrowthDigest;
    readonly scopeDigest: GrowthDigest;
    readonly commandDigest: GrowthDigest;
  };
  readonly historyDigest: GrowthDigest;
  readonly evidenceManifestDigest: GrowthDigest;
}

export interface GrowthAuthorityRequest {
  readonly schemaVersion: typeof growthAuthoritySchemaVersion;
  readonly kind: "request";
  readonly operation: "check" | "promote-release";
  readonly admissionReceiptId: string | null;
  readonly binding: GrowthAuthorityBinding;
  readonly contextSelectors: GrowthContextRequest;
  readonly decisionDigests: readonly GrowthDigest[];
  readonly requiredPhases: typeof growthAuthorityRequiredPhases;
}

export interface GrowthAuthorityReleasedEvidence {
  readonly packageName: string;
  readonly releaseEvidence: PackageReleaseEvidence;
  readonly observation?: GrowthSurfaceObservation;
  readonly evidence:
    | { readonly kind: "released"; readonly typed: PublicApiSnapshot; readonly artifact: PublicApiSnapshot }
    | { readonly kind: "initial-unreleased"; readonly historyDigest: GrowthDigest };
}

export interface GrowthAuthorityGrant {
  readonly schemaVersion: typeof growthAuthoritySchemaVersion;
  readonly kind: "grant";
  readonly grantId: string;
  readonly requestDigest: GrowthDigest;
  readonly admissionReceipt: { readonly kind: "none" } | { readonly kind: "receipt"; readonly receipt: GrowthAuthorityReceipt };
  readonly binding: GrowthAuthorityBinding;
  readonly workflowRef: string;
  readonly runRef: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly trustedBase: GrowthSurfaceObservation;
  readonly trustedBaseReference: GrowthObservationReference;
  readonly retainedHistory: {
    readonly targetSource: GrowthAuthoritySource;
    readonly targetSurfaceDigest: GrowthDigest;
    readonly receiptDigest: GrowthDigest;
    readonly custodyEvidenceDigest: GrowthDigest;
  };
  readonly released: readonly GrowthAuthorityReleasedEvidence[];
  readonly ownerEvidence: readonly GrowthAuthorityOwnerEvidence[];
  readonly archives: readonly {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly source: GrowthAuthoritySource;
    readonly archiveDigest: GrowthDigest;
    readonly archiveIntegrity: string;
    readonly custodyEvidenceDigest: GrowthDigest;
  }[];
  readonly requiredCoverageDigest: GrowthDigest;
  readonly requiredPhases: typeof growthAuthorityRequiredPhases;
}

export interface GrowthPromotionPlan {
  readonly binding: GrowthAuthorityBinding;
  readonly writes: readonly {
    readonly destination: string;
    readonly operation: "create" | "replace";
    readonly preimageDigest: GrowthDigest | null;
    readonly proposedDigest: GrowthDigest;
  }[];
}

export interface GrowthAuthorityCompletion {
  readonly schemaVersion: typeof growthAuthoritySchemaVersion;
  readonly kind: "completion";
  readonly grantId: string;
  readonly grantDigest: GrowthDigest;
  readonly requestDigest: GrowthDigest;
  readonly binding: GrowthAuthorityBinding;
  readonly reportDigest: GrowthDigest;
  readonly reportByteLength: number;
  readonly coverageDigest: GrowthDigest;
  readonly phasesDigest: GrowthDigest;
  readonly verdict: "admitted" | "rejected" | "incomplete";
  readonly releaseEligible: boolean;
  readonly publication: "finalized";
  readonly promotion: { readonly kind: "none" } | { readonly kind: "plan"; readonly planDigest: GrowthDigest };
}

export interface GrowthAuthorityReceipt {
  readonly schemaVersion: typeof growthAuthoritySchemaVersion;
  readonly kind: "receipt";
  readonly receiptId: string;
  readonly grantId: string;
  readonly grantDigest: GrowthDigest;
  readonly completionDigest: GrowthDigest;
  readonly binding: GrowthAuthorityBinding;
  readonly reportDigest: GrowthDigest;
  readonly coverageDigest: GrowthDigest;
  readonly phasesDigest: GrowthDigest;
  readonly verdict: "admitted" | "rejected" | "incomplete";
  readonly releaseEligible: boolean;
  readonly qualification: "qualified" | "not-qualified";
  readonly operation: "check" | "promote-release";
  readonly promotion: { readonly kind: "none" } | { readonly kind: "plan"; readonly planDigest: GrowthDigest };
  readonly custodyRef: string;
  readonly issuedAt: string;
}

export interface ResolvedGrowthAuthority {
  readonly request: GrowthAuthorityRequest;
  readonly requestDigest: GrowthDigest;
  readonly grant: GrowthAuthorityGrant;
  readonly grantDigest: GrowthDigest;
  readonly context: GrowthInputContext;
}

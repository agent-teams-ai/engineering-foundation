import type {
  MutationClaim, MutationIntent, MutationLease, MutationObservation
} from "../../../transaction-coordination/application-api.js";
import type { KnownFileTransactionPlanV1 } from "../model/known-file-transaction.js";

/** Known-file admission needs these capabilities; composition selects their provider. */
export interface KnownFileMutationPort {
  readonly installedRepositoryMutationBuildIdentity: () => Promise<`sha256:${string}`>;
  readonly installedRepositoryMutationVersion: () => Promise<string>;
  readonly acquireMutationLease: (root: string) => Promise<MutationLease>;
  readonly observeMutationState: (lease: MutationLease) => Promise<MutationObservation>;
  readonly claimMutation: (lease: MutationLease, observation: MutationObservation, intent: MutationIntent) => Promise<MutationClaim>;
  readonly consumeMutationClaim: (claim: MutationClaim, expectedKind: MutationIntent["kind"]) => Promise<string>;
  readonly mutationClaimIntent: (claim: MutationClaim) => MutationIntent;
  readonly retainMutationClaimBarrierOnEvidence: (claim: MutationClaim) => Promise<void>;
  readonly retainMutationBarrierOnEvidence: (lease: MutationLease) => Promise<boolean>;
  readonly retainMutationBarrier: (lease: MutationLease) => void;
  readonly releaseMutationLease: (lease: MutationLease) => Promise<void>;
}

export interface KnownFileApplyRequest {
  readonly consumerRoot: string;
  readonly plan: KnownFileTransactionPlanV1;
  readonly claim?: MutationClaim;
}

export interface KnownFileRecoveryRequest {
  readonly consumerRoot: string;
  readonly claim?: MutationClaim;
}

export interface KnownFileLeaseReleaseRequest {
  readonly jointFailureMessage: string;
  readonly lease: MutationLease;
  readonly primaryFailure?: { readonly reason: unknown };
  readonly retainTransactionBarrier: boolean;
}

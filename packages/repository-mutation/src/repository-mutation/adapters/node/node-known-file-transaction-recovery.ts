import { installedRepositoryMutationBuildIdentity } from "../../../installed-artifact-identity.js";
import { installedRepositoryMutationVersion, REPOSITORY_MUTATION_PACKAGE_NAME } from "../../../package-version.js";
import { pruneMutationStateDirectory } from "../../../transaction-coordination/adapters/node/node-state-directory.js";
import {
  acquireMutationLease, claimMutation, consumeMutationClaim, mutationClaimIntent, observeMutationState,
  retainMutationBarrierOnEvidence, retainMutationClaimBarrierOnEvidence,
  type MutationClaim, type MutationLease
} from "../../../transaction-coordination/mutation-lease.js";
import type { KnownFileTransactionReceiptV1 } from "../../application/model/known-file-transaction.js";
import { classifyKnownFileRecoveryTransition } from "../../application/policies/classify-known-file-recovery-transition.js";
import {
  executeApplyingKnownFileRollback,
  executeCommittedKnownFileRecovery,
  type KnownFileRecoveryFaultInjector
} from "./node-known-file-recovery-executor.js";
import {
  observeKnownFileRecoveryEvidence
} from "./node-known-file-recovery-observation.js";
import {
  canonicalKnownFileRoot,
  KnownFileTransactionError
} from "./node-known-file-transaction-filesystem.js";
import { releaseKnownFileTransactionLease } from "./node-known-file-transaction-lease-release.js";

export type { KnownFileRecoveryFaultInjector } from "./node-known-file-recovery-executor.js";

export async function recoverKnownFileTransactionWithFaults(options: {
  readonly consumerRoot: string;
  readonly claim?: MutationClaim;
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
}): Promise<KnownFileTransactionReceiptV1> {
  if (process.platform === "win32") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_APPLY_UNSUPPORTED",
      "Known-file recovery requires strict directory durability and is not qualified on Windows."
    );
  }
  const root = await canonicalKnownFileRoot(options.consumerRoot);
  let ownedLease: MutationLease | undefined;
  let claim = options.claim;
  ownedLease = claim === undefined ? await acquireMutationLease(root) : undefined;
  let retainBarrier = true;
  let primaryFailure: { readonly reason: unknown } | undefined;
  try {
    const [version, buildIdentity] = await Promise.all([
      installedRepositoryMutationVersion(), installedRepositoryMutationBuildIdentity()
    ]);
    const artifact = { name: REPOSITORY_MUTATION_PACKAGE_NAME, version, buildIdentity };
    if (claim === undefined) {
      const lease = ownedLease!;
      claim = await claimMutation(lease, await observeMutationState(lease), {
        kind: "recover-known-file", ownerArtifact: artifact, kernelArtifact: artifact
      });
    }
    const claimedIntent = mutationClaimIntent(claim);
    const exactArtifact = (candidate: { readonly name: string; readonly version: string; readonly buildIdentity: string }) =>
      candidate.name === artifact.name && candidate.version === artifact.version &&
      candidate.buildIdentity === artifact.buildIdentity;
    if (claimedIntent.kind !== "recover-known-file" || !exactArtifact(claimedIntent.ownerArtifact) ||
      !exactArtifact(claimedIntent.kernelArtifact) ||
      await consumeMutationClaim(claim, "recover-known-file") !== root) {
      throw new KnownFileTransactionError("KNOWN_FILE_RECOVERY_CONFLICT", "Mutation claim has the wrong root, owner, or kernel identity.");
    }
    const evidence = await observeKnownFileRecoveryEvidence(root);
    const transition = classifyKnownFileRecoveryTransition({
      envelope: evidence.stored.envelope,
      installedBuild: evidence.installedBuild
    });
    if (transition.action === "reject") {
      throw new KnownFileTransactionError(transition.code, transition.message);
    }
    const execution = {
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      root,
      store: evidence.store,
      stored: evidence.stored
    };
    const result = transition.action === "resume-committed-cleanup"
      ? await executeCommittedKnownFileRecovery(execution)
      : await executeApplyingKnownFileRollback(execution);
    retainBarrier = false;
    return result;
  } catch (error) {
    if (claim !== undefined) {await retainMutationClaimBarrierOnEvidence(claim);}
    if (ownedLease !== undefined) {await retainMutationBarrierOnEvidence(ownedLease);}
    primaryFailure = { reason: error };
    throw error;
  } finally {
    if (ownedLease !== undefined) {await releaseKnownFileTransactionLease({
      jointFailureMessage: "Known-file recovery and transaction lease release both failed.",
      lease: ownedLease,
      ...(primaryFailure === undefined ? {} : { primaryFailure }),
      retainTransactionBarrier: retainBarrier
    });}
    if (!retainBarrier) {await pruneMutationStateDirectory(root);}
  }
}

export function recoverKnownFileTransaction(options: {
  readonly consumerRoot: string;
  readonly claim?: MutationClaim;
}): Promise<KnownFileTransactionReceiptV1> {
  return recoverKnownFileTransactionWithFaults(options);
}

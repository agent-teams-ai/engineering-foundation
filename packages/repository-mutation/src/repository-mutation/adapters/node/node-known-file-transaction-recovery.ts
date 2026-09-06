import type { KnownFileCoordination } from "./known-file-coordination.js";

import type { KnownFileRecoveryRequest, KnownFileLeaseReleaseRequest } from "../../application/ports/known-file-mutation.js";
import { installedMutationArtifact, ensureRecoveryClaim, assertRecoveryClaim } from "../../application/policies/known-file-mutation-admission.js";

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
import { canonicalKnownFileRoot, hasPlainKnownFileOptionsPrototype } from "./node-known-file-transaction-filesystem.js";
import { KnownFileTransactionError } from "../../application/model/known-file-transaction-error.js";
import { releaseKnownFileTransactionLease } from "../../application/policies/known-file-transaction-lease-release.js";

export type { KnownFileRecoveryFaultInjector } from "./node-known-file-recovery-executor.js";

export async function recoverKnownFileTransactionWithFaults(coordination: Pick<KnownFileCoordination,
  "acquireMutationLease"
  | "assertTerminalEvidenceDirectory"
  | "captureFileHandleIdentity"
  | "claimMutation"
  | "consumeMutationClaim"
  | "ensureTerminalEvidenceDirectory"
  | "installedRepositoryMutationBuildIdentity"
  | "installedRepositoryMutationVersion"
  | "mutationClaimIntent"
  | "observeMutationState"
  | "pathMatchesRegularFileIdentity"
  | "pruneMutationStateDirectory"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
  | "releaseMutationLease"
  | "retainMutationBarrier"
  | "retainMutationBarrierOnEvidence"
  | "retainMutationClaimBarrierOnEvidence"
>, options: KnownFileRecoveryRequest & {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
}): Promise<KnownFileTransactionReceiptV1> {
  if (process.platform === "win32") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_APPLY_UNSUPPORTED",
      "Known-file recovery requires strict directory durability and is not qualified on Windows."
    );
  }
  const root = await canonicalKnownFileRoot(options.consumerRoot);
  let ownedLease: KnownFileLeaseReleaseRequest["lease"] | undefined;
  let claim = options.claim;
  ownedLease = claim === undefined ? await coordination.acquireMutationLease(root) : undefined;
  let retainBarrier = true;
  let primaryFailure: { readonly reason: unknown } | undefined;
  try {
    const artifact = await installedMutationArtifact(coordination);
    claim = await ensureRecoveryClaim(coordination, { artifact, claim, lease: ownedLease });
    await assertRecoveryClaim(coordination, { artifact, claim, root });
    const evidence = await observeKnownFileRecoveryEvidence(coordination, root);
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
      ? await executeCommittedKnownFileRecovery(coordination, execution)
      : await executeApplyingKnownFileRollback(coordination, execution);
    retainBarrier = false;
    return result;
  } catch (error) {
    if (claim !== undefined) {await coordination.retainMutationClaimBarrierOnEvidence(claim);}
    if (ownedLease !== undefined) {await coordination.retainMutationBarrierOnEvidence(ownedLease);}
    primaryFailure = { reason: error };
    throw error;
  } finally {
    if (ownedLease !== undefined) {await releaseKnownFileTransactionLease(coordination, {
      jointFailureMessage: "Known-file recovery and transaction lease release both failed.",
      lease: ownedLease,
      ...(primaryFailure === undefined ? {} : { primaryFailure }),
      retainTransactionBarrier: retainBarrier
    });}
    if (!retainBarrier) {await coordination.pruneMutationStateDirectory(root);}
  }
}

export function recoverKnownFileTransaction(coordination: Pick<KnownFileCoordination,
  "acquireMutationLease"
  | "assertTerminalEvidenceDirectory"
  | "captureFileHandleIdentity"
  | "claimMutation"
  | "consumeMutationClaim"
  | "ensureTerminalEvidenceDirectory"
  | "installedRepositoryMutationBuildIdentity"
  | "installedRepositoryMutationVersion"
  | "mutationClaimIntent"
  | "observeMutationState"
  | "pathMatchesRegularFileIdentity"
  | "pruneMutationStateDirectory"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
  | "releaseMutationLease"
  | "retainMutationBarrier"
  | "retainMutationBarrierOnEvidence"
  | "retainMutationClaimBarrierOnEvidence"
>, options: KnownFileRecoveryRequest): Promise<KnownFileTransactionReceiptV1> {
  const candidate: unknown = options;
  const keys = typeof candidate === "object" && candidate !== null
    ? Reflect.ownKeys(candidate)
    : [];
  const expectedKeys = keys.includes("claim")
    ? ["claim", "consumerRoot"]
    : ["consumerRoot"];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
    !hasPlainKnownFileOptionsPrototype(candidate) ||
    keys.some((key) => typeof key !== "string") ||
    (keys as string[]).toSorted().join("\0") !== expectedKeys.toSorted().join("\0") ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      return descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true;
    })) {
    return Promise.reject(new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      "Known-file recovery options contain unknown, missing, or executable properties."
    ));
  }
  const values = Object.fromEntries(keys.map((key) => [
    key as string,
    (Object.getOwnPropertyDescriptor(options, key)! as PropertyDescriptor & { value: unknown }).value
  ]));
  const input = Object.hasOwn(values, "claim")
    ? { consumerRoot: values["consumerRoot"] as string, claim: values["claim"] as NonNullable<KnownFileRecoveryRequest["claim"]> }
    : { consumerRoot: values["consumerRoot"] as string };
  return recoverKnownFileTransactionWithFaults(coordination, input);
}

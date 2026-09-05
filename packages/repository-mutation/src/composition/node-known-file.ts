import type { link, mkdir, rename } from "node:fs/promises";
import type { PortablePathIdentity } from "../path-identity.js";
import type { MutationClaim } from "../transaction-coordination/application-api.js";
import type {
  AbsentFilePublicationFaultInjector,
  AbsentFilePublicationOperations,
  AbsentFilePublicationOptions,
  AbsentFilePublicationOutcome,
  DirectoryDurability,
  ExactFilePostimage,
  ExactFilePostimageState,
  KnownFileRecoveryFaultInjector,
  KnownFileTransactionBarrierInspection,
  KnownFileTransactionFaultInjector,
  KnownFileTransactionPlanV1,
  KnownFileTransactionReceiptV1,
  OwnedTemporaryCleanupTransitionPort,
  PrepareExactSiblingTemporaryOptions
} from "../repository-mutation/composition/node-api.js";
import { createKnownFileNodeApi } from "../repository-mutation/composition/node-api.js";
import {
  acquireMutationLease,
  assertTerminalEvidenceDirectory,
  captureFileHandleIdentity,
  claimMutation,
  consumeMutationClaim,
  ensureMutationStateDirectory,
  ensureTerminalEvidenceDirectory,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
  mutationClaimIntent,
  observeMutationState,
  pathMatchesRegularFileIdentity,
  pruneMutationStateDirectory,
  readBoundedRegularFile,
  readBoundedRegularFileHandle,
  releaseMutationLease,
  retainMutationBarrier,
  retainMutationBarrierOnEvidence,
  retainMutationClaimBarrierOnEvidence
} from "../transaction-coordination/composition/node.js";

const knownFileNodeApi = createKnownFileNodeApi({
  acquireMutationLease,
  assertTerminalEvidenceDirectory,
  captureFileHandleIdentity,
  claimMutation,
  consumeMutationClaim,
  ensureMutationStateDirectory,
  ensureTerminalEvidenceDirectory,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
  mutationClaimIntent,
  observeMutationState,
  pathMatchesRegularFileIdentity,
  pruneMutationStateDirectory,
  readBoundedRegularFile,
  readBoundedRegularFileHandle,
  releaseMutationLease,
  retainMutationBarrier,
  retainMutationBarrierOnEvidence,
  retainMutationClaimBarrierOnEvidence
});

export function applyKnownFileTransaction(options: {
  readonly consumerRoot: string;
  readonly plan: KnownFileTransactionPlanV1;
  readonly claim?: MutationClaim;
}): Promise<KnownFileTransactionReceiptV1> {
  return knownFileNodeApi.applyKnownFileTransaction(options);
}

export function applyKnownFileTransactionWithFaults(options: {
  readonly consumerRoot: string;
  readonly plan: KnownFileTransactionPlanV1;
  readonly claim?: MutationClaim;
  readonly faultInjector?: KnownFileTransactionFaultInjector;
}): Promise<KnownFileTransactionReceiptV1> {
  return knownFileNodeApi.applyKnownFileTransactionWithFaults(options);
}

export function classifyExactFilePostimage(destinationPath: string, postimage: ExactFilePostimage): Promise<ExactFilePostimageState> {
  return knownFileNodeApi.classifyExactFilePostimage(destinationPath, postimage);
}

export function cleanupIdentityMatchingOwnedTemporary(options: {
  readonly allowUnsupportedDirectoryDurability: boolean;
  readonly displayPath: string;
  readonly expectedIdentity: PortablePathIdentity;
  readonly parent: string;
  readonly rm: (path: string) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<DirectoryDurability>;
  readonly temporaryPath: string;
  readonly transition?: OwnedTemporaryCleanupTransitionPort;
  readonly operations?: {
    readonly beforeLogicalRetirement?: (path: string) => Promise<void> | void;
    readonly mkdir?: typeof mkdir;
    readonly link?: typeof link;
    readonly pathMatchesRegularFileIdentity?: typeof pathMatchesRegularFileIdentity;
    readonly quarantineToken?: () => string;
    readonly rename?: typeof rename;
  };
}): Promise<"different" | "missing" | "removed"> {
  return knownFileNodeApi.cleanupIdentityMatchingOwnedTemporary(options);
}

export function inspectKnownFileTransactionBarrier(options: {
  readonly consumerRoot: string;
}): Promise<KnownFileTransactionBarrierInspection> {
  return knownFileNodeApi.inspectKnownFileTransactionBarrier(options);
}

export function prepareExactSiblingTemporary(options: PrepareExactSiblingTemporaryOptions): Promise<PortablePathIdentity> {
  return knownFileNodeApi.prepareExactSiblingTemporary(options);
}

export function prepareExactSiblingTemporaryWithFaults(options: PrepareExactSiblingTemporaryOptions & {
  readonly faultInjector?: (point: {
    readonly phase: "after-temporary-written";
  }) => Promise<void> | void;
}): Promise<PortablePathIdentity> {
  return knownFileNodeApi.prepareExactSiblingTemporaryWithFaults(options);
}

export function publishAbsentFile(options: AbsentFilePublicationOptions): Promise<AbsentFilePublicationOutcome> {
  return knownFileNodeApi.publishAbsentFile(options);
}

export function publishAbsentFileWithFaults(options: AbsentFilePublicationOptions & {
  readonly faultInjector?: AbsentFilePublicationFaultInjector;
  readonly operations?: Partial<AbsentFilePublicationOperations>;
}): Promise<AbsentFilePublicationOutcome> {
  return knownFileNodeApi.publishAbsentFileWithFaults(options);
}

export function recoverKnownFileTransaction(options: {
  readonly consumerRoot: string;
  readonly claim?: MutationClaim;
}): Promise<KnownFileTransactionReceiptV1> {
  return knownFileNodeApi.recoverKnownFileTransaction(options);
}

export function recoverKnownFileTransactionWithFaults(options: {
  readonly consumerRoot: string;
  readonly claim?: MutationClaim;
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
}): Promise<KnownFileTransactionReceiptV1> {
  return knownFileNodeApi.recoverKnownFileTransactionWithFaults(options);
}

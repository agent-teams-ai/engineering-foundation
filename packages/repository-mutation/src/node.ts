// Node-only mechanism seams for closed owner-package compositions. These are
// intentionally absent from the root API, whose effectful surface is limited
// to Repository Mutation's closed known-file operations.
export {
  claimMutation,
  observeMutationState,
  releaseMutationLease,
  retainMutationBarrier
} from "./transaction-coordination/application/mutation-lease.js";
export { acquireMutationLease } from "./transaction-coordination/composition/node-mutation-lease.js";
export type {
  MutationArtifactIdentity,
  MutationClaim,
  MutationIntent,
  MutationLease,
  MutationObservation
} from "./transaction-coordination/application/mutation-lease.js";
export { captureFileHandleIdentity, readBoundedRegularFile, pathMatchesRegularFileIdentity } from "./transaction-coordination/adapters/node/node-bounded-regular-file.js";
export type { BoundedRegularFileRead } from "./transaction-coordination/adapters/node/node-bounded-regular-file.js";
export type { PathIdentityMatch, PortablePathIdentity } from "./path-identity.js";
export { assertTerminalEvidenceDirectory, ensureTerminalEvidenceDirectory } from "./transaction-coordination/adapters/node/node-terminal-evidence-directory.js";
export type {
  TerminalEvidenceDirectoryAuthority,
  TerminalEvidenceDirectoryOperations,
  TerminalEvidenceDirectoryStat,
} from "./transaction-coordination/adapters/node/node-terminal-evidence-directory.js";
export { ownedTemporaryCleanupResiduePrefix, OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER } from "./repository-mutation/adapters/node/node-cleanup-owned-temporary.js";
export { cleanupIdentityMatchingOwnedTemporary } from "./composition/node-known-file.js";
export { syncDirectoryDurably, syncDirectoryStrictly } from "./repository-mutation/adapters/node/node-directory-durability.js";
export type {
  DirectoryDurability,
  DirectoryDurabilityOperations,
  DirectorySyncHandle,
} from "./repository-mutation/adapters/node/node-directory-durability.js";
export { createAndBindNodeDirectory } from "./repository-mutation/adapters/node/node-create-and-bind-directory.js";
export type { NodeDirectoryCreateAndBindOperations } from "./repository-mutation/adapters/node/node-create-and-bind-directory.js";
export { prepareExactSiblingTemporary } from "./composition/node-known-file.js";
export type { PrepareExactSiblingTemporaryOptions } from "./repository-mutation/adapters/node/node-prepare-exact-sibling-temporary.js";
export { publishPreparedAbsentFile } from "./repository-mutation/adapters/node/node-publish-prepared-absent-file.js";
export type { PublishPreparedAbsentFileOptions } from "./repository-mutation/adapters/node/node-publish-prepared-absent-file.js";
export { assertNoPortableNameCollision, assertSafeExistingRepositoryAncestors, ExistingRepositoryAncestorError } from "./repository-mutation/adapters/node/node-existing-repository-ancestors.js";
export type { ExistingRepositoryAncestorProblem } from "./repository-mutation/adapters/node/node-existing-repository-ancestors.js";
export { isLexicallyContainedPath } from "./repository-mutation/adapters/node/node-repository-path.js";
export type { OwnedTemporaryCleanupTransition, OwnedTemporaryCleanupTransitionPort } from "./repository-mutation/application/ports/owned-temporary-cleanup-transition.js";
export { AbsentFilePublicationError } from "./repository-mutation/application/model/exact-postimage.js";
export type {
  AbsentFilePublicationErrorCode,
  AbsentFilePublicationOutcome,
  ExactFilePostimage,
  ExactFilePostimageState,
} from "./repository-mutation/application/model/exact-postimage.js";
export { assertTemporaryPathsAbsent } from "./repository-mutation/adapters/node/node-absent-file-publication.js";
export { classifyExactFilePostimage, publishAbsentFile } from "./composition/node-known-file.js";
export type { AbsentFilePublicationOptions } from "./repository-mutation/adapters/node/node-absent-file-publication.js";
export { ensureMutationStateDirectory, pruneMutationStateDirectory, syncMutationStateDirectory, syncMutationStateDirectoryStrictly } from "./transaction-coordination/adapters/node/node-state-directory.js";
export { NodeJournalSlotStore } from "./transaction-coordination/adapters/node/node-journal-slot-store.js";
export { sameJournalSlotAuthority } from "./transaction-coordination/application/journal-slot-profile.js";
export type {
  JournalSlotAuthority,
  JournalSlotCodec,
  JournalSlotEvidence,
  JournalSlotFailure,
  JournalSlotFailureContext,
  JournalSlotFailureFactory,
  JournalSlotFaultInjector,
  JournalSlotFaultPoint,
  JournalSlotMutation,
  JournalSlotNaming,
  JournalSlotObservation,
  JournalSlotProfile,
  JournalSlotResidueMatcher,
  JournalSlotSubject,
  JournalSlotSyncRole,
  JournalSlotSyncStage,
  StoredJournalSlot
} from "./transaction-coordination/application/journal-slot-profile.js";

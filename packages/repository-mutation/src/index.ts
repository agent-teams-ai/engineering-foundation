export { canonicalJson, sha256Bytes, sha256Json, sha256Text, CanonicalJsonError } from "./canonical-json.js";
export type { CanonicalJsonValue } from "./canonical-json.js";
export { parseStrictJson, StrictJsonError } from "./strict-json.js";
export type { StrictJsonFailure } from "./strict-json.js";
export { RepositoryMutationError } from "./errors.js";
export type { RepositoryMutationErrorCode } from "./errors.js";
export { computeInstalledArtifactBuildIdentity, installedRepositoryMutationBuildIdentity } from "./installed-artifact-identity.js";
export type { InstalledArtifactClosure, InstalledArtifactDigest } from "./installed-artifact-identity.js";
export { installedRepositoryMutationVersion, REPOSITORY_MUTATION_PACKAGE_NAME } from "./package-version.js";
export {
  acquireMutationLease,
  claimMutation,
  observeMutationState,
  releaseMutationLease,
  retainMutationBarrier
} from "./transaction-coordination/mutation-lease.js";
export type {
  MutationArtifactIdentity,
  MutationClaim,
  MutationIntent,
  MutationLease,
  MutationObservation
} from "./transaction-coordination/mutation-lease.js";
export type {
  BoundDirectoryCreation, CapturedDirectory, DirectoryCreatePolicy,
  DirectoryMaterializationProjection, DirectoryMutationErrorCode,
  ProjectedDirectory, UnboundDirectoryCreationRecovery
} from "./repository-mutation/application/model/directory-materialization.js";
export type { PortablePathIdentity } from "./repository-mutation/application/model/path-identity.js";
export { assertKnownFileTransactionPlan, compileKnownFileTransactionPlan, KnownFileTransactionPlanError } from "./repository-mutation/application/policies/known-file-transaction-plan.js";
export { applyKnownFileTransaction, canonicalKnownFileTransactionReceipt, KnownFileTransactionError } from "./repository-mutation/adapters/node/node-known-file-transaction.js";
export { recoverKnownFileTransaction } from "./repository-mutation/adapters/node/node-known-file-transaction-recovery.js";
export { inspectKnownFileTransactionBarrier } from "./repository-mutation/adapters/node/node-known-file-transaction-inspection.js";
export type { KnownFileTransactionBarrierInspection } from "./repository-mutation/adapters/node/node-known-file-transaction-inspection.js";
export type {
  CompileKnownFileTransactionPlanInput, KnownFileDigest, KnownFileImageV1,
  KnownFilePreconditionV1, KnownFileTransactionOperationInput,
  KnownFileTransactionOperationOutcome, KnownFileTransactionOperationV1,
  KnownFileTransactionPlanV1, KnownFileTransactionReceiptV1
} from "./repository-mutation/application/model/known-file-transaction.js";

// Finite portable mechanism seams used by Foundation composition.
export { captureFileHandleIdentity, readBoundedRegularFile, pathMatchesRegularFileIdentity } from "./repository-mutation/adapters/node/node-bounded-regular-file.js";
export type { BoundedRegularFileRead } from "./repository-mutation/adapters/node/node-bounded-regular-file.js";
export { assertTerminalEvidenceDirectory, ensureTerminalEvidenceDirectory } from "./repository-mutation/adapters/node/node-terminal-evidence-directory.js";
export { cleanupIdentityMatchingOwnedTemporary, ownedTemporaryCleanupResiduePrefix, OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER } from "./repository-mutation/adapters/node/node-cleanup-owned-temporary.js";
export { syncDirectoryDurably, syncDirectoryStrictly } from "./repository-mutation/adapters/node/node-directory-durability.js";
export { createAndBindNodeDirectory } from "./repository-mutation/adapters/node/node-create-and-bind-directory.js";
export { prepareExactSiblingTemporary } from "./repository-mutation/adapters/node/node-prepare-exact-sibling-temporary.js";
export { publishPreparedAbsentFile } from "./repository-mutation/adapters/node/node-publish-prepared-absent-file.js";
export { assertNoPortableNameCollision, assertSafeExistingRepositoryAncestors, ExistingRepositoryAncestorError } from "./repository-mutation/adapters/node/node-existing-repository-ancestors.js";
export { isLexicallyContainedPath } from "./repository-mutation/adapters/node/node-repository-path.js";
export { portableRepositoryPathIdentity, portableRepositoryPathProblem } from "./repository-mutation/application/model/repository-path.js";
export type { PortableRepositoryPathProblem } from "./repository-mutation/application/model/repository-path.js";
export type { OwnedTemporaryCleanupTransition, OwnedTemporaryCleanupTransitionPort } from "./repository-mutation/application/ports/owned-temporary-cleanup-transition.js";
export { AbsentFilePublicationError } from "./repository-mutation/application/model/exact-postimage.js";
export type { ExactFilePostimage } from "./repository-mutation/application/model/exact-postimage.js";
export { assertTemporaryPathsAbsent, classifyExactFilePostimage, publishAbsentFile } from "./repository-mutation/adapters/node/node-absent-file-publication.js";
export { assertKnownFileTransactionEnvelope } from "./repository-mutation/application/policies/known-file-transaction-envelope.js";
export { ensureMutationStateDirectory, pruneMutationStateDirectory, syncMutationStateDirectory, syncMutationStateDirectoryStrictly } from "./transaction-coordination/adapters/node/node-state-directory.js";

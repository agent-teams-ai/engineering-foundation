export type {
  BoundDirectoryCreation,
  CapturedDirectory,
  DirectoryCreatePolicy,
  DirectoryMaterializationProjection,
  DirectoryMutationErrorCode,
  ProjectedDirectory,
  UnboundDirectoryCreationRecovery
} from "../repository-mutation/application/model/directory-materialization.js";
export type { PortablePathIdentity } from "../repository-mutation/application/model/path-identity.js";
export {
  assertKnownFileTransactionPlan,
  compileKnownFileTransactionPlan,
  KnownFileTransactionPlanError
} from "../repository-mutation/application/policies/known-file-transaction-plan.js";
export {
  applyKnownFileTransaction,
  canonicalKnownFileTransactionReceipt,
  KnownFileTransactionError
} from "../repository-mutation/adapters/node/node-known-file-transaction.js";
export { recoverKnownFileTransaction } from "../repository-mutation/adapters/node/node-known-file-transaction-recovery.js";
/**
 * @deprecated Qualification-only seam. Import from
 * `@agent-teams/engineering-foundation/mutation/qualification`.
 */
export type { KnownFileRecoveryFaultInjector } from "../repository-mutation/adapters/node/node-known-file-transaction-recovery.js";
export { inspectKnownFileTransactionBarrier } from "../repository-mutation/adapters/node/node-known-file-transaction-inspection.js";
export type { KnownFileTransactionBarrierInspection } from "../repository-mutation/adapters/node/node-known-file-transaction-inspection.js";
/**
 * @deprecated Qualification-only seams. Import from
 * `@agent-teams/engineering-foundation/mutation/qualification`.
 */
export type {
  KnownFileTransactionFaultInjector,
  KnownFileTransactionFaultPoint
} from "../repository-mutation/adapters/node/node-known-file-transaction.js";
export type {
  CompileKnownFileTransactionPlanInput,
  KnownFileDigest,
  KnownFileImageV1,
  KnownFilePreconditionV1,
  KnownFileTransactionOperationInput,
  KnownFileTransactionOperationOutcome,
  KnownFileTransactionOperationV1,
  KnownFileTransactionPlanV1,
  KnownFileTransactionReceiptV1
} from "../repository-mutation/application/model/known-file-transaction.js";

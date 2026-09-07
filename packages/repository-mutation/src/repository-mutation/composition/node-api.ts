import type { KnownFileCoordination } from "../adapters/node/known-file-coordination.js";
import { createKnownFileNodeAdapter } from "../adapters/node/node-known-file-api.js";

export function createKnownFileNodeApi(coordination: KnownFileCoordination) {
  return createKnownFileNodeAdapter(coordination);
}

// Exact public signature types used by the module's named Node API forwarders.
export type { KnownFileTransactionPlanV1, KnownFileTransactionReceiptV1 } from "../application/model/known-file-transaction.js";
export type { AbsentFilePublicationOutcome, ExactFilePostimage, ExactFilePostimageState } from "../application/model/exact-postimage.js";
export type { OwnedTemporaryCleanupTransitionPort } from "../application/ports/owned-temporary-cleanup-transition.js";
export type { KnownFileTransactionBarrierInspection } from "../adapters/node/node-known-file-transaction-inspection.js";
export type { KnownFileTransactionFaultInjector } from "../adapters/node/node-known-file-transaction.js";
export type { KnownFileRecoveryFaultInjector } from "../adapters/node/node-known-file-transaction-recovery.js";
export type { PrepareExactSiblingTemporaryOptions } from "../adapters/node/node-prepare-exact-sibling-temporary.js";
export type { AbsentFilePublicationFaultInjector, AbsentFilePublicationOperations, AbsentFilePublicationOptions } from "../adapters/node/node-absent-file-publication.js";
export type { DirectoryDurability } from "../adapters/node/node-directory-durability.js";

import type { KnownFileCoordination } from "../adapters/node/known-file-coordination.js";
import { applyKnownFileTransaction, applyKnownFileTransactionWithFaults } from "../adapters/node/node-known-file-transaction.js";

import { classifyExactFilePostimage, publishAbsentFile, publishAbsentFileWithFaults } from "../adapters/node/node-absent-file-publication.js";
import { cleanupIdentityMatchingOwnedTemporary } from "../adapters/node/node-cleanup-owned-temporary.js";
import { inspectKnownFileTransactionBarrier } from "../adapters/node/node-known-file-transaction-inspection.js";
import { prepareExactSiblingTemporary, prepareExactSiblingTemporaryWithFaults } from "../adapters/node/node-prepare-exact-sibling-temporary.js";


import { recoverKnownFileTransaction, recoverKnownFileTransactionWithFaults } from "../adapters/node/node-known-file-transaction-recovery.js";

export function createKnownFileNodeApi(coordination: KnownFileCoordination) {
  return {
    applyKnownFileTransaction: applyKnownFileTransaction.bind(undefined, coordination),
    applyKnownFileTransactionWithFaults: applyKnownFileTransactionWithFaults.bind(undefined, coordination),
    classifyExactFilePostimage: classifyExactFilePostimage.bind(undefined, coordination),
    cleanupIdentityMatchingOwnedTemporary: cleanupIdentityMatchingOwnedTemporary.bind(undefined, coordination),
    inspectKnownFileTransactionBarrier: inspectKnownFileTransactionBarrier.bind(undefined, coordination),
    prepareExactSiblingTemporary: prepareExactSiblingTemporary.bind(undefined, coordination),
    prepareExactSiblingTemporaryWithFaults: prepareExactSiblingTemporaryWithFaults.bind(undefined, coordination),
    publishAbsentFile: publishAbsentFile.bind(undefined, coordination),
    publishAbsentFileWithFaults: publishAbsentFileWithFaults.bind(undefined, coordination),
    recoverKnownFileTransaction: recoverKnownFileTransaction.bind(undefined, coordination),
    recoverKnownFileTransactionWithFaults: recoverKnownFileTransactionWithFaults.bind(undefined, coordination),
  };
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

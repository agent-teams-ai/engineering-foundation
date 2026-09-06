import type { PortablePathIdentity } from "../../../path-identity.js";
import type { ExactFilePostimage, ExactFilePostimageState, AbsentFilePublicationOutcome } from "../../application/model/exact-postimage.js";
import type { KnownFileTransactionReceiptV1 } from "../../application/model/known-file-transaction.js";
import type { KnownFileApplyRequest, KnownFileRecoveryRequest } from "../../application/ports/known-file-mutation.js";
import type { KnownFileCoordination } from "./known-file-coordination.js";
import { applyKnownFileTransaction as applyTransaction, applyKnownFileTransactionWithFaults as applyTransactionWithFaults } from "./node-known-file-transaction.js";
import { classifyExactFilePostimage as classifyPostimage, publishAbsentFile as publishFile, publishAbsentFileWithFaults as publishFileWithFaults } from "./node-absent-file-publication.js";
import { cleanupIdentityMatchingOwnedTemporary as cleanupTemporary } from "./node-cleanup-owned-temporary.js";
import { inspectKnownFileTransactionBarrier as inspectBarrier } from "./node-known-file-transaction-inspection.js";
import { prepareExactSiblingTemporary as prepareTemporary, prepareExactSiblingTemporaryWithFaults as prepareTemporaryWithFaults } from "./node-prepare-exact-sibling-temporary.js";
import { recoverKnownFileTransaction as recoverTransaction, recoverKnownFileTransactionWithFaults as recoverTransactionWithFaults } from "./node-known-file-transaction-recovery.js";

/** Node operations over the feature's ports, with concrete providers selected by composition. */
export function createKnownFileNodeAdapter(coordination: KnownFileCoordination) {
  // Return each completion directly: requests, claims, failures and promise timing
  // remain owned by the existing operations.
  function applyKnownFileTransaction(options: KnownFileApplyRequest): Promise<KnownFileTransactionReceiptV1> {
    return applyTransaction(coordination, options);
  }

  function applyKnownFileTransactionWithFaults(options: Parameters<typeof applyTransactionWithFaults>[1]): Promise<KnownFileTransactionReceiptV1> {
    return applyTransactionWithFaults(coordination, options);
  }

  function classifyExactFilePostimage(destinationPath: string, postimage: ExactFilePostimage): Promise<ExactFilePostimageState> {
    return classifyPostimage(coordination, destinationPath, postimage);
  }

  function cleanupIdentityMatchingOwnedTemporary(options: Parameters<typeof cleanupTemporary>[1]): Promise<"different" | "missing" | "removed"> {
    return cleanupTemporary(coordination, options);
  }

  function inspectKnownFileTransactionBarrier(options: Parameters<typeof inspectBarrier>[1]): ReturnType<typeof inspectBarrier> {
    return inspectBarrier(coordination, options);
  }

  function prepareExactSiblingTemporary(options: Parameters<typeof prepareTemporary>[1]): Promise<PortablePathIdentity> {
    return prepareTemporary(coordination, options);
  }

  function prepareExactSiblingTemporaryWithFaults(options: Parameters<typeof prepareTemporaryWithFaults>[1]): Promise<PortablePathIdentity> {
    return prepareTemporaryWithFaults(coordination, options);
  }

  function publishAbsentFile(options: Parameters<typeof publishFile>[1]): Promise<AbsentFilePublicationOutcome> {
    return publishFile(coordination, options);
  }

  function publishAbsentFileWithFaults(options: Parameters<typeof publishFileWithFaults>[1]): Promise<AbsentFilePublicationOutcome> {
    return publishFileWithFaults(coordination, options);
  }

  function recoverKnownFileTransaction(options: KnownFileRecoveryRequest): Promise<KnownFileTransactionReceiptV1> {
    return recoverTransaction(coordination, options);
  }

  function recoverKnownFileTransactionWithFaults(options: Parameters<typeof recoverTransactionWithFaults>[1]): Promise<KnownFileTransactionReceiptV1> {
    return recoverTransactionWithFaults(coordination, options);
  }

  return {
    applyKnownFileTransaction,
    applyKnownFileTransactionWithFaults,
    classifyExactFilePostimage,
    cleanupIdentityMatchingOwnedTemporary,
    inspectKnownFileTransactionBarrier,
    prepareExactSiblingTemporary,
    prepareExactSiblingTemporaryWithFaults,
    publishAbsentFile,
    publishAbsentFileWithFaults,
    recoverKnownFileTransaction,
    recoverKnownFileTransactionWithFaults,
  };
}

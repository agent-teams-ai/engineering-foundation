import type { KnownFileCoordination } from "./known-file-coordination.js";
import type { KnownFileTransactionReceiptV1 } from "../../application/model/known-file-transaction.js";
import { cleanupCommittedKnownFileCaptures } from "./node-known-file-recovery-filesystem.js";
import { rollbackKnownFileRecovery } from "./node-known-file-recovery-cleanup.js";
import {
  type KnownFileRecoveryFaultInjector,
  type StoredRecoveryJournal
} from "./node-known-file-recovery-state.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import { verifyCommittedKnownFilePostimages } from "./node-known-file-transaction.js";
import { compileKnownFileTransactionReceipt } from "../../application/policies/known-file-transaction-receipt.js";
import { compileRolledBackReceipt } from "./node-known-file-transaction-receipt.js";
import { verifyRolledBackKnownFileState } from "./node-known-file-recovery-observation.js";

export type { KnownFileRecoveryFaultInjector } from "./node-known-file-recovery-state.js";

export async function executeCommittedKnownFileRecovery(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">, options: {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<KnownFileTransactionReceiptV1> {
  await verifyCommittedKnownFilePostimages(coordination, options.root, options.stored.envelope.payload);
  await cleanupCommittedKnownFileCaptures(coordination,
    options.root,
    options.stored.envelope.payload,
    options.faultInjector
  );
  await verifyCommittedKnownFilePostimages(coordination, options.root, options.stored.envelope.payload);
  const result = compileKnownFileTransactionReceipt(
    options.stored.envelope.payload,
    "applied"
  );
  await options.store.remove(options.stored.authority);
  return result;
}

export async function executeApplyingKnownFileRollback(coordination: Pick<KnownFileCoordination,
  "captureFileHandleIdentity"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
>, options: {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<KnownFileTransactionReceiptV1> {
  await rollbackKnownFileRecovery(coordination, options);
  await verifyRolledBackKnownFileState(coordination, options.root, options.stored.envelope.payload);
  const result = compileRolledBackReceipt(options.stored.envelope.payload);
  await options.store.remove(options.stored.authority);
  return result;
}

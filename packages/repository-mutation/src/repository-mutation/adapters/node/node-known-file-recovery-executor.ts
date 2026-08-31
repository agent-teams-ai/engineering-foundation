import type { KnownFileTransactionReceiptV1 } from "../../application/model/known-file-transaction.js";
import { cleanupCommittedKnownFileCaptures } from "./node-known-file-recovery-filesystem.js";
import { rollbackKnownFileRecovery } from "./node-known-file-recovery-cleanup.js";
import {
  type KnownFileRecoveryFaultInjector,
  type StoredRecoveryJournal
} from "./node-known-file-recovery-state.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import {
  compileKnownFileTransactionReceipt,
  verifyCommittedKnownFilePostimages
} from "./node-known-file-transaction.js";
import { compileRolledBackReceipt } from "./node-known-file-transaction-receipt.js";
import { verifyRolledBackKnownFileState } from "./node-known-file-recovery-observation.js";

export type { KnownFileRecoveryFaultInjector } from "./node-known-file-recovery-state.js";

export async function executeCommittedKnownFileRecovery(options: {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<KnownFileTransactionReceiptV1> {
  await verifyCommittedKnownFilePostimages(options.root, options.stored.envelope.payload);
  await cleanupCommittedKnownFileCaptures(
    options.root,
    options.stored.envelope.payload,
    options.faultInjector
  );
  await verifyCommittedKnownFilePostimages(options.root, options.stored.envelope.payload);
  const result = compileKnownFileTransactionReceipt(
    options.stored.envelope.payload,
    "applied"
  );
  await options.store.remove(options.stored.authority);
  return result;
}

export async function executeApplyingKnownFileRollback(options: {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<KnownFileTransactionReceiptV1> {
  await rollbackKnownFileRecovery(options);
  await verifyRolledBackKnownFileState(options.root, options.stored.envelope.payload);
  const result = compileRolledBackReceipt(options.stored.envelope.payload);
  await options.store.remove(options.stored.authority);
  return result;
}

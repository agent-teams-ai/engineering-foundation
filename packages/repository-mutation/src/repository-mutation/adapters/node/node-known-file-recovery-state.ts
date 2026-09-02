import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import { compileKnownFileTransactionEnvelope } from "../../application/policies/known-file-transaction-envelope.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import type { StoredKnownFileRecoveryJournal } from "./node-known-file-recovery-observation.js";

export type StoredRecoveryJournal = StoredKnownFileRecoveryJournal;

export type KnownFileRecoveryFaultInjector = (point: {
  readonly phase:
    | "after-committed-capture-unlinked"
    | "after-destination-retired"
    | "after-rollback-linked"
    | "after-rollback-capture-unlinked"
    | "after-retirement-directory-bound"
    | "after-retirement-captured"
    | "after-retirement-unlink-authorized";
  readonly operationIndex: number;
  readonly path: string;
}) => Promise<void> | void;

export async function persistRecoveryJournal(
  store: NodeKnownFileTransactionJournalStore,
  stored: StoredRecoveryJournal,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  const envelope = compileKnownFileTransactionEnvelope({
    ownerArtifact: stored.envelope.ownerArtifact,
    kernelArtifact: stored.envelope.kernelArtifact,
    journal,
    state: stored.envelope.state
  });
  stored.authority = await store.replace(stored.authority, envelope);
  stored.envelope = envelope;
}

export function replaceRecoveryOperation(
  journal: KnownFileTransactionJournalV1,
  index: number,
  operation: KnownFileTransactionJournalV1["operations"][number]
): KnownFileTransactionJournalV1 {
  return Object.freeze({
    ...journal,
    operations: Object.freeze(journal.operations.with(index, operation))
  });
}

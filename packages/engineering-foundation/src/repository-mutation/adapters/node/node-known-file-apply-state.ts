import type {
  KnownFileTransactionEnvelopeV1,
  KnownFileTransactionJournalOperationV1,
  KnownFileTransactionJournalV1
} from "../../application/model/known-file-transaction-journal.js";
import { compileKnownFileTransactionEnvelope } from "../../application/policies/known-file-transaction-envelope.js";
import type {
  KnownFileJournalAuthority,
  NodeKnownFileTransactionJournalStore
} from "./node-known-file-transaction-journal-store.js";

export interface KnownFileApplyState {
  authority: KnownFileJournalAuthority;
  envelope: KnownFileTransactionEnvelopeV1;
}

function replaceKnownFileOperation(
  journal: KnownFileTransactionJournalV1,
  index: number,
  replacement: KnownFileTransactionJournalOperationV1
): KnownFileTransactionJournalV1 {
  return Object.freeze({
    ...journal,
    operations: Object.freeze(journal.operations.with(index, replacement))
  });
}

export function transitionKnownFileOperation(
  journal: KnownFileTransactionJournalV1,
  index: number,
  transition: Partial<KnownFileTransactionJournalOperationV1>
): KnownFileTransactionJournalV1 {
  const current = journal.operations[index]!;
  return replaceKnownFileOperation(
    journal,
    index,
    Object.freeze({ ...current, ...transition }) as KnownFileTransactionJournalOperationV1
  );
}

export async function persistKnownFileApplyState(
  store: NodeKnownFileTransactionJournalStore,
  stored: KnownFileApplyState,
  journal: KnownFileTransactionJournalV1,
  state: KnownFileTransactionEnvelopeV1["state"] = "APPLYING"
): Promise<void> {
  const envelope = compileKnownFileTransactionEnvelope({
    foundation: stored.envelope.foundation,
    journal,
    state
  });
  stored.authority = await store.replace(stored.authority, envelope);
  stored.envelope = envelope;
}

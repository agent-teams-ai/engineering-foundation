import type { DocumentTransactionEnvelope } from "../model/document-transaction.js";

export interface JournalIdentity {
  readonly adapter: "node-filesystem";
  readonly version: 1;
  readonly dev: string;
  readonly ino: string;
  readonly birthtimeNs: string;
  readonly authorityDigest: `sha256:${string}`;
}

export interface StoredDocumentJournal {
  readonly envelope: DocumentTransactionEnvelope;
  readonly identity: JournalIdentity;
}

export interface DocumentJournalStore {
  read(): Promise<StoredDocumentJournal | undefined>;
  /**
   * Establishes a fresh durability boundary before reconciliation and returns
   * a residue-free stable observation of the canonical slot.
   */
  stabilizeForReconciliation(): Promise<StoredDocumentJournal | undefined>;
  create(envelope: DocumentTransactionEnvelope): Promise<JournalIdentity>;
  replace(request: {
    readonly expectedIdentity: JournalIdentity;
    readonly envelope: DocumentTransactionEnvelope;
  }): Promise<JournalIdentity>;
  remove(expectedIdentity: JournalIdentity): Promise<void>;
}

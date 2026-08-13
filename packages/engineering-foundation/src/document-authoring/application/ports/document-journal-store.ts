import type { DocumentTransactionEnvelope } from "../model/document-transaction.js";

export interface JournalIdentity {
  readonly adapter: "node-filesystem";
  readonly version: 1;
  readonly dev: string;
  readonly ino: string;
  readonly birthtimeNs: string;
}

export interface JournalAuthority {
  readonly identity: JournalIdentity;
  readonly authorityDigest: `sha256:${string}`;
}

export interface StoredDocumentJournal {
  readonly envelope: DocumentTransactionEnvelope;
  readonly authority: JournalAuthority;
}

export interface DocumentJournalStore {
  read(): Promise<StoredDocumentJournal | undefined>;
  /**
   * Establishes a fresh durability boundary before reconciliation and returns
   * a residue-free stable observation of the canonical slot.
   */
  stabilizeForReconciliation(): Promise<StoredDocumentJournal | undefined>;
  create(envelope: DocumentTransactionEnvelope): Promise<JournalAuthority>;
  replace(request: {
    readonly expectedAuthority: JournalAuthority;
    readonly envelope: DocumentTransactionEnvelope;
  }): Promise<JournalAuthority>;
  remove(expectedAuthority: JournalAuthority): Promise<void>;
}

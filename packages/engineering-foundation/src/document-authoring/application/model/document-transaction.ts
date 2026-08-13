import type { DocumentAuthorityDigest } from "./document-catalog.js";
import type { DocumentPhysicalIdentity } from "./document-physical-identity.js";
import type { DocumentPlan } from "./document-planning.js";

export interface DocumentOwnedTemporary {
  readonly path: string;
  readonly digest: DocumentAuthorityDigest;
  readonly identity: DocumentPhysicalIdentity;
}

interface DocumentJournalBase {
  readonly schemaVersion: 2;
  readonly plan: DocumentPlan;
}

export type DocumentTransactionJournal =
  | (DocumentJournalBase & {
      readonly destination: {
        readonly path: string;
        readonly state: "pending";
      };
    })
  | (DocumentJournalBase & {
      readonly destination: {
        readonly path: string;
        readonly state: "preexisting";
      };
    })
  | (DocumentJournalBase & {
      readonly destination: {
        readonly path: string;
        readonly state: "publishing";
      };
      readonly ownedTemporary: DocumentOwnedTemporary;
    })
  | (DocumentJournalBase & {
      readonly destination: {
        readonly path: string;
        readonly state: "published";
      };
      readonly publicationIdentity: DocumentPhysicalIdentity;
    });

interface DocumentTransactionEnvelopeBase {
  readonly schemaVersion: 3;
  readonly operationKind: "document-authoring";
  readonly recoveryHandler: {
    readonly id: "foundation.document-authoring";
    readonly contractVersion: 2;
  };
  readonly foundation: {
    readonly version: string;
    readonly buildIdentity: DocumentAuthorityDigest;
  };
  readonly adapterContractVersion: 1;
  readonly payloadKind: "document-authoring-journal/v2";
  readonly payloadDigest: DocumentAuthorityDigest;
  readonly envelopeDigest: DocumentAuthorityDigest;
}

export type DocumentTransactionEnvelope =
  | (DocumentTransactionEnvelopeBase & {
      readonly state: "PREPARED";
      readonly journal: Extract<
        DocumentTransactionJournal,
        { readonly destination: { readonly state: "pending" } }
      > | Extract<
        DocumentTransactionJournal,
        { readonly destination: { readonly state: "preexisting" } }
      >;
    })
  | (DocumentTransactionEnvelopeBase & {
      readonly state: "PUBLISHING";
      readonly journal: Extract<
        DocumentTransactionJournal,
        { readonly destination: { readonly state: "publishing" } }
      >;
    })
  | (DocumentTransactionEnvelopeBase & {
      readonly state: "PUBLISHED";
      readonly journal: Extract<
        DocumentTransactionJournal,
        { readonly destination: { readonly state: "published" } }
      >;
    });

type WithoutEnvelopeDigests<T> = T extends unknown
  ? Omit<T, "envelopeDigest" | "payloadDigest">
  : never;

export type DocumentTransactionEnvelopeBody =
  WithoutEnvelopeDigests<DocumentTransactionEnvelope>;

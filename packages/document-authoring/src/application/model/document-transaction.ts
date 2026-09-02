import type { DocumentAuthorityDigest } from "./document-catalog.js";
import type { DocumentPhysicalIdentity } from "./document-physical-identity.js";
import type { DocumentPlanV1, DocumentPlanV2 } from "./document-planning.js";
import type {
  DocumentCreatedDirectoryEvidenceV2
} from "./document-parent-materialization.js";

export interface DocumentOwnedTemporary {
  readonly path: string;
  readonly digest: DocumentAuthorityDigest;
  readonly identity: DocumentPhysicalIdentity;
}

export interface DocumentJournalBase {
  readonly schemaVersion: 2;
  readonly plan: DocumentPlanV1;
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

export interface DocumentTransactionEnvelopeBase {
  readonly schemaVersion: 3;
  readonly operationKind: "document-authoring";
  readonly recoveryHandler: {
    readonly id: "document-authoring" | "foundation.document-authoring";
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

export type DocumentTransactionEnvelopeV3 =
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

export interface DocumentTransactionJournalV3Base {
  readonly schemaVersion: 3;
  readonly plan: DocumentPlanV2;
  readonly parentMaterialization: {
    readonly anchorIdentity: DocumentPhysicalIdentity;
    readonly createdDirectories: readonly DocumentCreatedDirectoryEvidenceV2[];
    readonly pendingDirectory?: string;
  };
}

export type DocumentTransactionJournalV3 =
  | (DocumentTransactionJournalV3Base & {
      readonly destination: { readonly path: string; readonly state: "pending" };
    })
  | (DocumentTransactionJournalV3Base & {
      readonly destination: { readonly path: string; readonly state: "preexisting" };
    })
  | (DocumentTransactionJournalV3Base & {
      readonly destination: { readonly path: string; readonly state: "materializing" };
    })
  | (DocumentTransactionJournalV3Base & {
      readonly destination: { readonly path: string; readonly state: "publishing" };
      readonly ownedTemporary: DocumentOwnedTemporary;
    })
  | (DocumentTransactionJournalV3Base & {
      readonly destination: { readonly path: string; readonly state: "published" };
      readonly publicationIdentity: DocumentPhysicalIdentity;
    });

export interface DocumentTransactionEnvelopeV4Base {
  readonly schemaVersion: 4;
  readonly operationKind: "document-authoring";
  readonly recoveryHandler: {
    readonly id: "document-authoring" | "foundation.document-authoring";
    readonly contractVersion: 3;
  };
  readonly foundation: {
    readonly version: string;
    readonly buildIdentity: DocumentAuthorityDigest;
  };
  readonly adapterContractVersion: 1;
  readonly payloadKind: "document-authoring-journal/v3";
  readonly payloadDigest: DocumentAuthorityDigest;
  readonly envelopeDigest: DocumentAuthorityDigest;
}

export type DocumentTransactionEnvelopeV4 =
  | (DocumentTransactionEnvelopeV4Base & {
      readonly state: "PREPARED";
      readonly journal:
        | Extract<DocumentTransactionJournalV3, {
            readonly destination: { readonly state: "pending" };
          }>
        | Extract<DocumentTransactionJournalV3, {
            readonly destination: { readonly state: "preexisting" };
          }>;
    })
  | (DocumentTransactionEnvelopeV4Base & {
      readonly state: "MATERIALIZING";
      readonly journal: Extract<DocumentTransactionJournalV3, {
        readonly destination: { readonly state: "materializing" };
      }>;
    })
  | (DocumentTransactionEnvelopeV4Base & {
      readonly state: "PUBLISHING";
      readonly journal: Extract<DocumentTransactionJournalV3, {
        readonly destination: { readonly state: "publishing" };
      }>;
    })
  | (DocumentTransactionEnvelopeV4Base & {
      readonly state: "PUBLISHED";
      readonly journal: Extract<DocumentTransactionJournalV3, {
        readonly destination: { readonly state: "published" };
      }>;
    });

export type DocumentTransactionEnvelope =
  | DocumentTransactionEnvelopeV3
  | DocumentTransactionEnvelopeV4;

type WithoutEnvelopeDigests<T> = T extends unknown
  ? Omit<T, "envelopeDigest" | "payloadDigest">
  : never;

export type DocumentTransactionEnvelopeBody =
  WithoutEnvelopeDigests<DocumentTransactionEnvelope>;

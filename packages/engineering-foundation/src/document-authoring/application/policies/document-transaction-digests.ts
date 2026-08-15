import {
  canonicalJson,
  type CanonicalJsonValue,
  sha256Json
} from "../../../canonical-json.js";
import type { DocumentAuthorityDigest } from "../model/document-catalog.js";
import type {
  DocumentTransactionEnvelope,
  DocumentTransactionJournal,
  DocumentTransactionJournalV3
} from "../model/document-transaction.js";

function canonicalSnapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value as unknown as CanonicalJsonValue)) as T;
}

export function documentTransactionPayloadDigest(
  journal: DocumentTransactionJournal | DocumentTransactionJournalV3
): DocumentAuthorityDigest {
  return sha256Json(canonicalSnapshot(journal) as unknown as CanonicalJsonValue);
}

export function documentTransactionEnvelopeDigest(
  envelope:
    | DocumentTransactionEnvelope
    | Omit<DocumentTransactionEnvelope, "envelopeDigest">
): DocumentAuthorityDigest {
  const { envelopeDigest: _ignored, ...body } =
    envelope as DocumentTransactionEnvelope;
  return sha256Json(
    canonicalSnapshot(body) as unknown as CanonicalJsonValue
  );
}

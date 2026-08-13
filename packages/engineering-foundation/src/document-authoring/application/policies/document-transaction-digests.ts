import {
  canonicalJson,
  type CanonicalJsonValue,
  sha256Json
} from "../../../canonical-json.js";
import type { DocumentAuthorityDigest } from "../model/document-catalog.js";
import type {
  DocumentTransactionEnvelope,
  DocumentTransactionJournal
} from "../model/document-transaction.js";

function canonicalSnapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value as unknown as CanonicalJsonValue)) as T;
}

export function documentTransactionPayloadDigest(
  journal: DocumentTransactionJournal
): DocumentAuthorityDigest {
  return sha256Json(canonicalSnapshot(journal) as unknown as CanonicalJsonValue);
}

export function documentTransactionEnvelopeDigest(
  envelope: Omit<DocumentTransactionEnvelope, "envelopeDigest">
): DocumentAuthorityDigest {
  const snapshot = canonicalSnapshot(
    envelope as unknown as Record<string, CanonicalJsonValue>
  );
  const { envelopeDigest: _ignored, ...body } = snapshot;
  return sha256Json(body);
}

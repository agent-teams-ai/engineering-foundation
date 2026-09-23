import { canonicalJson, type CanonicalJsonValue, sha256Text } from "@agent-teams/repository-mutation/serialization";
import type { DocumentAuthorityDigest } from "../model/document-catalog.js";
import type {
  DocumentTransactionEnvelope,
  DocumentTransactionJournal,
  DocumentTransactionJournalV3
} from "../model/document-transaction.js";

export function documentTransactionPayloadDigest(
  journal: DocumentTransactionJournal | DocumentTransactionJournalV3
): DocumentAuthorityDigest {
  return sha256Text(canonicalJson(journal as unknown as CanonicalJsonValue));
}

export function documentTransactionEnvelopeDigest(
  envelope:
    | DocumentTransactionEnvelope
    | Omit<DocumentTransactionEnvelope, "envelopeDigest">
): DocumentAuthorityDigest {
  const { envelopeDigest: _ignored, ...body } =
    envelope as DocumentTransactionEnvelope;
  return sha256Text(canonicalJson(body as unknown as CanonicalJsonValue));
}

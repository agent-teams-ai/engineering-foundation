import {
  canonicalJson,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
import type {
  DocumentTransactionEnvelope,
  DocumentTransactionEnvelopeBody,
  DocumentTransactionJournal
} from "../model/document-transaction.js";
import { assertDocumentPlanDigests } from "./document-contract-digests.js";
import {
  documentTransactionEnvelopeDigest,
  documentTransactionPayloadDigest
} from "./document-transaction-digests.js";

export class DocumentTransactionEnvelopeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentTransactionEnvelopeError";
  }
}

function canonicalSnapshot<T>(value: T): T {
  try {
    return JSON.parse(
      canonicalJson(value as unknown as CanonicalJsonValue)
    ) as T;
  } catch (error) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope must use canonical JSON values.",
      { cause: error }
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnedTemporary(
  journal: DocumentTransactionJournal
): journal is Extract<
  DocumentTransactionJournal,
  { readonly ownedTemporary: unknown }
> {
  return "ownedTemporary" in journal;
}

function assertLifecycleBindings(
  envelope: DocumentTransactionEnvelope
): void {
  const { journal } = envelope;
  const { destination } = journal;
  if (
    destination.path !== journal.plan.destination ||
    envelope.foundation.version !== journal.plan.compiler.version ||
    envelope.foundation.buildIdentity !== journal.plan.compiler.buildIdentity
  ) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction lifecycle does not bind the embedded Plan."
    );
  }
  const temporaryDigest = hasOwnedTemporary(journal)
    ? journal.ownedTemporary.digest
    : undefined;
  if (
    envelope.state !== "PREPARED" &&
    temporaryDigest !== journal.plan.output.digest
  ) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction temporary does not bind the planned output."
    );
  }
}

export function assertDocumentTransactionEnvelope(
  value: unknown
): asserts value is DocumentTransactionEnvelope {
  const candidate = canonicalSnapshot(value);
  if (!isRecord(candidate)) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope must be an object."
    );
  }
  const handler = candidate["recoveryHandler"];
  if (
    candidate["schemaVersion"] !== 2 ||
    candidate["operationKind"] !== "document-authoring" ||
    !isRecord(handler) ||
    handler["id"] !== "foundation.document-authoring" ||
    handler["contractVersion"] !== 1 ||
    candidate["adapterContractVersion"] !== 1 ||
    candidate["payloadKind"] !== "document-authoring-journal/v1" ||
    !["PREPARED", "PUBLISHING", "PUBLISHED"].includes(
      String(candidate["state"])
    )
  ) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope constants are invalid."
    );
  }
  const envelope = candidate as unknown as DocumentTransactionEnvelope;
  assertDocumentPlanDigests(envelope.journal.plan);
  assertLifecycleBindings(envelope);
  if (
    envelope.payloadDigest !==
    documentTransactionPayloadDigest(envelope.journal) ||
    envelope.envelopeDigest !==
    documentTransactionEnvelopeDigest(envelope)
  ) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope digest is invalid."
    );
  }
}

export function createDocumentTransactionEnvelope(
  body: DocumentTransactionEnvelopeBody
): DocumentTransactionEnvelope {
  const snapshot = canonicalSnapshot(body);
  const withPayload = {
    ...snapshot,
    payloadDigest: documentTransactionPayloadDigest(snapshot.journal)
  } as Omit<DocumentTransactionEnvelope, "envelopeDigest">;
  const envelope = Object.freeze({
    ...withPayload,
    envelopeDigest: documentTransactionEnvelopeDigest(withPayload)
  }) as DocumentTransactionEnvelope;
  assertDocumentTransactionEnvelope(envelope);
  return envelope;
}

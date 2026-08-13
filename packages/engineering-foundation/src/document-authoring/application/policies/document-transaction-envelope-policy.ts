import {
  canonicalJson,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
import { assertSchema } from "../../../schema-catalog.js";
import type {
  DocumentTransactionEnvelope,
  DocumentTransactionEnvelopeBody,
  DocumentTransactionJournal
} from "../model/document-transaction.js";
import {
  assertDocumentPhysicalIdentity,
  assertNonzeroDocumentPhysicalIdentity
} from "../model/document-physical-identity.js";
import { assertDocumentPlanDigests } from "./document-contract-digests.js";
import { documentTemporaryPath } from "./document-temporary-path.js";
import {
  documentTransactionEnvelopeDigest,
  documentTransactionPayloadDigest
} from "./document-transaction-digests.js";

class DocumentTransactionEnvelopeError extends Error {
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

function deepFreezeCanonical<T>(value: T): T {
  const pending: object[] = [];
  if (value !== null && typeof value === "object") {
    pending.push(value);
  }
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || Object.isFrozen(current)) {
      continue;
    }
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      const child: unknown = descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
      if (typeof child === "object" && child !== null) {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  return value;
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
  if (
    hasOwnedTemporary(journal) &&
    journal.ownedTemporary.digest !== journal.plan.output.digest
  ) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction temporary does not bind the planned output."
    );
  }
  if (hasOwnedTemporary(journal)) {
    assertDocumentPhysicalIdentity(journal.ownedTemporary.identity);
    if (
      journal.ownedTemporary.path !==
      documentTemporaryPath(journal.plan.destination, journal.plan.planDigest)
    ) {
      throw new DocumentTransactionEnvelopeError(
        "Document transaction temporary path does not bind the embedded Plan."
      );
    }
  }
  if (envelope.state === "PUBLISHED") {
    assertNonzeroDocumentPhysicalIdentity(
      envelope.journal.publicationIdentity
    );
  }
}

export async function assertDocumentTransactionEnvelope(
  value: unknown
): Promise<DocumentTransactionEnvelope> {
  const candidate = deepFreezeCanonical(canonicalSnapshot(value));
  if (!isRecord(candidate)) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope must be an object."
    );
  }
  const handler = candidate["recoveryHandler"];
  if (
    candidate["schemaVersion"] !== 3 ||
    candidate["operationKind"] !== "document-authoring" ||
    !isRecord(handler) ||
    handler["id"] !== "foundation.document-authoring" ||
    handler["contractVersion"] !== 2 ||
    candidate["adapterContractVersion"] !== 1 ||
    candidate["payloadKind"] !== "document-authoring-journal/v2" ||
    !["PREPARED", "PUBLISHING", "PUBLISHED"].includes(
      String(candidate["state"])
    )
  ) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope constants are invalid."
    );
  }
  try {
    await assertSchema(
      "foundation-transaction-envelope/v3",
      candidate,
      "document-transaction-envelope"
    );
  } catch (error) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope does not match the closed v3 schema.",
      { cause: error }
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
  return envelope;
}

export async function createDocumentTransactionEnvelope(
  body: DocumentTransactionEnvelopeBody
): Promise<DocumentTransactionEnvelope> {
  const snapshot = deepFreezeCanonical(canonicalSnapshot(body));
  const withPayload = {
    ...snapshot,
    payloadDigest: documentTransactionPayloadDigest(snapshot.journal)
  } as Omit<DocumentTransactionEnvelope, "envelopeDigest">;
  const envelope = deepFreezeCanonical({
    ...withPayload,
    envelopeDigest: documentTransactionEnvelopeDigest(withPayload)
  }) as DocumentTransactionEnvelope;
  const validated = await assertDocumentTransactionEnvelope(envelope);
  if (validated.state === "PUBLISHING") {
    assertNonzeroDocumentPhysicalIdentity(
      validated.journal.ownedTemporary.identity
    );
  }
  return validated;
}

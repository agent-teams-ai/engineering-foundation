import {
  canonicalJson,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
import { assertSchema } from "../../../schema-catalog.js";
import type {
  DocumentTransactionEnvelope,
  DocumentTransactionEnvelopeBody,
  DocumentTransactionJournal,
  DocumentTransactionJournalV3
} from "../model/document-transaction.js";
import { assertNonzeroDocumentPhysicalIdentity } from "../model/document-physical-identity.js";
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
  journal: DocumentTransactionJournal | DocumentTransactionJournalV3
): journal is Extract<
  DocumentTransactionJournal,
  { readonly ownedTemporary: unknown }
> {
  return "ownedTemporary" in journal;
}

function assertV4MaterializationBindings(
  envelope: Extract<DocumentTransactionEnvelope, { readonly schemaVersion: 4 }>
): void {
  const materialization = envelope.journal.parentMaterialization;
  assertNonzeroDocumentPhysicalIdentity(materialization.anchorIdentity);
  const planned = envelope.journal.plan.parentMaterialization.missingDirectories;
  if (materialization.createdDirectories.length > planned.length ||
    materialization.createdDirectories.some((entry, index) => {
      assertNonzeroDocumentPhysicalIdentity(entry.identity);
      return entry.path !== planned[index];
    })) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction directory evidence is not an exact Plan prefix."
    );
  }
  const pending = materialization.pendingDirectory;
  if (envelope.state === "PREPARED" && materialization.createdDirectories.length !== 0) {
    throw new DocumentTransactionEnvelopeError(
      "PREPARED must not contain created directory evidence."
    );
  }
  if (envelope.state === "MATERIALIZING" && planned.length === 0) {
    throw new DocumentTransactionEnvelopeError(
      "MATERIALIZING requires at least one planned directory."
    );
  }
  if (pending !== undefined &&
    pending !== planned[materialization.createdDirectories.length]) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction pending directory does not bind the next Plan path."
    );
  }
  if (envelope.state !== "MATERIALIZING" && pending !== undefined) {
    throw new DocumentTransactionEnvelopeError(
      "Only MATERIALIZING may retain a pending directory."
    );
  }
  if ((envelope.state === "PUBLISHING" || envelope.state === "PUBLISHED") &&
    materialization.createdDirectories.length !== planned.length) {
    throw new DocumentTransactionEnvelopeError(
      "Document publication requires complete directory materialization evidence."
    );
  }
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
    assertNonzeroDocumentPhysicalIdentity(journal.ownedTemporary.identity);
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
  if (envelope.schemaVersion === 4) {
    assertV4MaterializationBindings(envelope);
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
    ![3, 4].includes(Number(candidate["schemaVersion"])) ||
    candidate["operationKind"] !== "document-authoring" ||
    !isRecord(handler) ||
    handler["id"] !== "foundation.document-authoring" ||
    handler["contractVersion"] !==
      (candidate["schemaVersion"] === 4 ? 3 : 2) ||
    candidate["adapterContractVersion"] !== 1 ||
    candidate["payloadKind"] !==
      (candidate["schemaVersion"] === 4
        ? "document-authoring-journal/v3"
        : "document-authoring-journal/v2") ||
    !(candidate["schemaVersion"] === 4
      ? ["PREPARED", "MATERIALIZING", "PUBLISHING", "PUBLISHED"]
      : ["PREPARED", "PUBLISHING", "PUBLISHED"]).includes(
      String(candidate["state"])
    )
  ) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope constants are invalid."
    );
  }
  try {
    await assertSchema(
      candidate["schemaVersion"] === 4
        ? "foundation-transaction-envelope/v4"
        : "foundation-transaction-envelope/v3",
      candidate,
      "document-transaction-envelope"
    );
  } catch (error) {
    throw new DocumentTransactionEnvelopeError(
      "Document transaction envelope does not match its closed versioned schema.",
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
  return assertDocumentTransactionEnvelope(envelope);
}

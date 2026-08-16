import {
  canonicalJson,
  sha256Json,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
import type {
  KnownFileTransactionEnvelopeV1,
  KnownFileTransactionJournalV1
} from "../model/known-file-transaction-journal.js";
import { deserializeKnownFileIdentity } from "../model/known-file-transaction-journal.js";
import type { KnownFileTransactionPlanV1 } from "../model/known-file-transaction.js";
import { assertKnownFileTransactionPlan } from "./known-file-transaction-plan.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

export class KnownFileTransactionEnvelopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KnownFileTransactionEnvelopeError";
  }
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KnownFileTransactionEnvelopeError(`${subject} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  subject: string
): void {
  if (Object.keys(value).toSorted().join(",") !== [...keys].toSorted().join(",")) {
    throw new KnownFileTransactionEnvelopeError(`${subject} has unknown or missing fields.`);
  }
}

function assertIdentity(value: unknown, subject: string): void {
  const identity = record(value, subject);
  exactKeys(identity, ["birthtimeNs", "dev", "ino"], subject);
  for (const field of ["birthtimeNs", "dev", "ino"] as const) {
    if (!POSITIVE_INTEGER.test(String(identity[field]))) {
      throw new KnownFileTransactionEnvelopeError(`${subject}.${field} is invalid.`);
    }
  }
  deserializeKnownFileIdentity(identity as unknown as {
    readonly birthtimeNs: string;
    readonly dev: string;
    readonly ino: string;
  });
}

function assertJournalOperation(
  candidate: unknown,
  index: number,
  plan: KnownFileTransactionPlanV1
): void {
    const operation = record(candidate, `Known-file journal operation ${index}`);
    const state = operation["state"];
    const withTemporary = ["temporary-ready", "publishing", "published"].includes(String(state));
    exactKeys(
      operation,
      withTemporary
        ? operation["matchedPreimage"] === undefined
          ? ["path", "state", "temporaryIdentity"]
          : ["matchedPreimage", "path", "state", "temporaryIdentity"]
        : operation["matchedPreimage"] === undefined
          ? ["path", "state"]
          : ["matchedPreimage", "path", "state"],
      `Known-file journal operation ${index}`
    );
    if (operation["path"] !== plan.operations[index]?.path ||
      !["already-satisfied", "pending", "temporary-ready", "publishing", "published"].includes(String(state))) {
      throw new KnownFileTransactionEnvelopeError(`Known-file journal operation ${index} is invalid.`);
    }
    const matched = operation["matchedPreimage"];
    const precondition = plan.operations[index]?.precondition;
    if (matched !== undefined &&
      (!Number.isSafeInteger(matched) || (matched as number) < 0 ||
        precondition?.state !== "known-file" || (matched as number) >= precondition.acceptedPreimages.length)) {
      throw new KnownFileTransactionEnvelopeError(`Known-file journal operation ${index} preimage binding is invalid.`);
    }
    if (withTemporary) {
      assertIdentity(operation["temporaryIdentity"], `Known-file journal operation ${index} temporary identity`);
    }
}

function assertCreatedDirectories(value: unknown): void {
  if (!Array.isArray(value) || value.length > 128) {
    throw new KnownFileTransactionEnvelopeError("Known-file created-directory evidence is invalid.");
  }
  for (const [index, candidate] of value.entries()) {
    const directory = record(candidate, `Known-file created directory ${index}`);
    exactKeys(directory, ["identity", "path"], `Known-file created directory ${index}`);
    if (typeof directory["path"] !== "string") {
      throw new KnownFileTransactionEnvelopeError(`Known-file created directory ${index} path is invalid.`);
    }
    assertIdentity(directory["identity"], `Known-file created directory ${index} identity`);
  }
}

function assertJournal(value: unknown): asserts value is KnownFileTransactionJournalV1 {
  const journal = record(value, "Known-file transaction journal");
  exactKeys(journal, ["createdDirectories", "operations", "plan", "schemaVersion"], "Known-file transaction journal");
  if (journal["schemaVersion"] !== 1) {
    throw new KnownFileTransactionEnvelopeError("Known-file transaction journal version is unsupported.");
  }
  assertKnownFileTransactionPlan(journal["plan"]);
  const plan = journal["plan"];
  if (!Array.isArray(journal["operations"]) || journal["operations"].length !== plan.operations.length) {
    throw new KnownFileTransactionEnvelopeError("Known-file transaction journal operations do not bind the Plan.");
  }
  journal["operations"].forEach((candidate, index) => {
    assertJournalOperation(candidate, index, plan);
  });
  assertCreatedDirectories(journal["createdDirectories"]);
}

function body(input: {
  readonly foundation: KnownFileTransactionEnvelopeV1["foundation"];
  readonly journal: KnownFileTransactionJournalV1;
  readonly state: KnownFileTransactionEnvelopeV1["state"];
}) {
  const payloadDigest = sha256Json(input.journal as unknown as CanonicalJsonValue);
  return {
    schemaVersion: 5 as const,
    operationKind: "known-file-transaction" as const,
    recoveryHandler: {
      id: "foundation.replace-known-file" as const,
      contractVersion: 1 as const
    },
    foundation: input.foundation,
    adapterContractVersion: 1 as const,
    payloadKind: "known-file-transaction-journal/v1" as const,
    state: input.state,
    journal: input.journal,
    payloadDigest
  };
}

export function compileKnownFileTransactionEnvelope(input: {
  readonly foundation: KnownFileTransactionEnvelopeV1["foundation"];
  readonly journal: KnownFileTransactionJournalV1;
  readonly state: KnownFileTransactionEnvelopeV1["state"];
}): KnownFileTransactionEnvelopeV1 {
  assertJournal(input.journal);
  if (!SHA256.test(input.foundation.buildIdentity) || input.foundation.version.length === 0) {
    throw new KnownFileTransactionEnvelopeError("Known-file transaction Foundation identity is invalid.");
  }
  const envelopeBody = body(input);
  return Object.freeze({
    ...envelopeBody,
    envelopeDigest: sha256Json(envelopeBody as unknown as CanonicalJsonValue)
  });
}

export function assertKnownFileTransactionEnvelope(
  value: unknown
): asserts value is KnownFileTransactionEnvelopeV1 {
  const envelope = record(value, "Known-file transaction envelope");
  exactKeys(envelope, [
    "adapterContractVersion", "envelopeDigest", "foundation", "journal",
    "operationKind", "payloadDigest", "payloadKind", "recoveryHandler",
    "schemaVersion", "state"
  ], "Known-file transaction envelope");
  const foundation = record(envelope["foundation"], "Known-file Foundation identity");
  const recovery = record(envelope["recoveryHandler"], "Known-file recovery handler");
  exactKeys(foundation, ["buildIdentity", "version"], "Known-file Foundation identity");
  exactKeys(recovery, ["contractVersion", "id"], "Known-file recovery handler");
  if (envelope["schemaVersion"] !== 5 ||
    envelope["operationKind"] !== "known-file-transaction" ||
    envelope["adapterContractVersion"] !== 1 ||
    envelope["payloadKind"] !== "known-file-transaction-journal/v1" ||
    !["APPLYING", "COMMITTED"].includes(String(envelope["state"])) ||
    recovery["id"] !== "foundation.replace-known-file" ||
    recovery["contractVersion"] !== 1 ||
    typeof foundation["version"] !== "string" ||
    !SHA256.test(String(foundation["buildIdentity"]))) {
    throw new KnownFileTransactionEnvelopeError("Known-file transaction envelope binding is invalid.");
  }
  assertJournal(envelope["journal"]);
  const reconstructed = compileKnownFileTransactionEnvelope({
    foundation: foundation as unknown as KnownFileTransactionEnvelopeV1["foundation"],
    journal: envelope["journal"],
    state: envelope["state"] as KnownFileTransactionEnvelopeV1["state"]
  });
  if (canonicalJson(reconstructed as unknown as CanonicalJsonValue) !==
    canonicalJson(value as CanonicalJsonValue)) {
    throw new KnownFileTransactionEnvelopeError("Known-file transaction envelope is non-canonical or tampered.");
  }
}

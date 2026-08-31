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
import { portableRepositoryPathProblem } from "../model/repository-path.js";
import { assertKnownFileTransactionPlan } from "./known-file-transaction-plan.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

class KnownFileTransactionEnvelopeError extends Error {
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

function journalOperationKeys(
  operation: Record<string, unknown>,
  withTemporary: boolean
): string[] {
  if (!withTemporary) {
    return operation["matchedPreimage"] === undefined
      ? ["path", "state"]
      : ["matchedPreimage", "path", "state"];
  }
  return [
    ...(operation["matchedPreimage"] === undefined ? [] : ["matchedPreimage"]),
    "path",
    ...(operation["rollbackTemporaryIdentity"] === undefined
      ? []
      : ["rollbackTemporaryIdentity"]),
    ...(operation["captureDirectoryIdentity"] === undefined
      ? []
      : ["captureDirectoryIdentity"]),
    ...(operation["capturedPreimageIdentity"] === undefined
      ? []
      : ["capturedPreimageIdentity"]),
    ...(operation["retirement"] === undefined ? [] : ["retirement"]),
    "state",
    "temporaryIdentity"
  ];
}

function assertJournalOperationIdentities(options: {
  readonly index: number;
  readonly operation: Record<string, unknown>;
  readonly precondition: KnownFileTransactionPlanV1["operations"][number]["precondition"] | undefined;
  readonly state: unknown;
}): void {
  const subject = `Known-file journal operation ${options.index}`;
  assertIdentity(options.operation["temporaryIdentity"], `${subject} temporary identity`);
  if (options.operation["rollbackTemporaryIdentity"] !== undefined) {
    if (options.precondition?.state !== "known-file") {
      throw new KnownFileTransactionEnvelopeError(`${subject} rollback identity is invalid.`);
    }
    assertIdentity(options.operation["rollbackTemporaryIdentity"], `${subject} rollback temporary identity`);
  }
  if (options.operation["captureDirectoryIdentity"] !== undefined) {
    if (options.precondition?.state !== "known-file") {
      throw new KnownFileTransactionEnvelopeError(`${subject} capture directory identity is invalid.`);
    }
    assertIdentity(options.operation["captureDirectoryIdentity"], `${subject} capture directory identity`);
  }
  if (options.operation["capturedPreimageIdentity"] !== undefined) {
    if (options.precondition?.state !== "known-file" ||
      options.operation["captureDirectoryIdentity"] === undefined ||
      !["preimage-captured", "destination-retired", "publishing", "published", "rollback-restored"].includes(String(options.state))) {
      throw new KnownFileTransactionEnvelopeError(`${subject} captured preimage identity is invalid.`);
    }
    assertIdentity(options.operation["capturedPreimageIdentity"], `${subject} captured preimage identity`);
  }
  if (options.operation["retirement"] !== undefined) {
    const retirement = record(options.operation["retirement"], `${subject} retirement`);
    exactKeys(retirement, ["directoryIdentity", "kind", "pathIdentity", "state"], `${subject} retirement`);
    if (!["destination", "rollback-temporary", "temporary"].includes(String(retirement["kind"])) ||
      !["ready", "captured", "unlink-authorized"].includes(String(retirement["state"]))) {
      throw new KnownFileTransactionEnvelopeError(`${subject} retirement transition is invalid.`);
    }
    assertIdentity(retirement["directoryIdentity"], `${subject} retirement directory identity`);
    assertIdentity(retirement["pathIdentity"], `${subject} retirement path identity`);
  }
  if (["capture-ready", "preimage-captured", "destination-retired"].includes(String(options.state)) &&
    options.operation["captureDirectoryIdentity"] === undefined) {
    throw new KnownFileTransactionEnvelopeError(`${subject} lacks capture directory identity.`);
  }
}

function assertJournalOperation(
  candidate: unknown,
  index: number,
  plan: KnownFileTransactionPlanV1
): void {
    const operation = record(candidate, `Known-file journal operation ${index}`);
    const state = operation["state"];
    const withTemporary = [
      "temporary-ready", "capture-authorized", "capture-ready", "preimage-captured",
      "destination-retired", "publishing", "published", "rollback-restored"
    ].includes(String(state));
    exactKeys(operation, journalOperationKeys(operation, withTemporary), `Known-file journal operation ${index}`);
    if (operation["path"] !== plan.operations[index]?.path ||
      ![
        "already-satisfied", "pending", "temporary-authorized", "temporary-ready", "capture-authorized", "capture-ready",
        "preimage-captured", "destination-retired", "publishing", "published", "rollback-restored"
      ].includes(String(state))) {
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
      assertJournalOperationIdentities({ index, operation, precondition, state });
    }
}

function permittedParentDirectories(plan: KnownFileTransactionPlanV1): Set<string> {
  const permitted = new Set<string>();
  for (const operation of plan.operations) {
    const segments = operation.path.split("/");
    segments.pop();
    for (let count = 1; count <= segments.length; count += 1) {
      permitted.add(segments.slice(0, count).join("/"));
    }
  }
  return permitted;
}

function assertCreatedDirectories(
  value: unknown,
  plan: KnownFileTransactionPlanV1
): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new KnownFileTransactionEnvelopeError("Known-file created-directory evidence is invalid.");
  }
  const permitted = permittedParentDirectories(plan);
  const paths: string[] = [];
  for (const [index, candidate] of value.entries()) {
    const directory = record(candidate, `Known-file created directory ${index}`);
    exactKeys(directory, ["identity", "path"], `Known-file created directory ${index}`);
    if (typeof directory["path"] !== "string" ||
      portableRepositoryPathProblem(directory["path"]) !== undefined ||
      directory["path"].normalize("NFC") !== directory["path"] ||
      !permitted.has(directory["path"])) {
      throw new KnownFileTransactionEnvelopeError(`Known-file created directory ${index} path is invalid.`);
    }
    assertIdentity(directory["identity"], `Known-file created directory ${index} identity`);
    paths.push(directory["path"]);
  }
  if (new Set(paths).size !== paths.length) {
    throw new KnownFileTransactionEnvelopeError("Known-file created-directory evidence contains duplicates.");
  }
  return paths;
}

function assertJournal(value: unknown): asserts value is KnownFileTransactionJournalV1 {
  const journal = record(value, "Known-file transaction journal");
  exactKeys(journal, ["authorizedDirectories", "createdDirectories", "operations", "plan", "schemaVersion"], "Known-file transaction journal");
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
  const createdPaths = assertCreatedDirectories(journal["createdDirectories"], plan);
  const authorizedDirectories: unknown = journal["authorizedDirectories"];
  if (!Array.isArray(authorizedDirectories) || authorizedDirectories.length > 128 ||
    authorizedDirectories.some((path: unknown) => typeof path !== "string" ||
      portableRepositoryPathProblem(path) !== undefined || path.normalize("NFC") !== path ||
      !permittedParentDirectories(plan).has(path)) ||
    new Set(authorizedDirectories as string[]).size !== authorizedDirectories.length ||
    (authorizedDirectories as string[]).some((path) => createdPaths.includes(path))) {
    throw new KnownFileTransactionEnvelopeError("Known-file authorized-directory evidence is invalid.");
  }
}

function body(input: {
  readonly ownerArtifact: KnownFileTransactionEnvelopeV1["ownerArtifact"];
  readonly kernelArtifact: KnownFileTransactionEnvelopeV1["kernelArtifact"];
  readonly journal: KnownFileTransactionJournalV1;
  readonly state: KnownFileTransactionEnvelopeV1["state"];
}) {
  const payloadDigest = sha256Json(input.journal as unknown as CanonicalJsonValue);
  return {
    schemaVersion: 6 as const,
    format: "agent-teams.repository-mutation.transaction-envelope/v1" as const,
    operationKind: "known-file-transaction" as const,
    recoveryHandler: {
      id: "agent-teams.repository-mutation.known-file/v1" as const,
      contractVersion: 1 as const
    },
    ownerArtifact: input.ownerArtifact,
    kernelArtifact: input.kernelArtifact,
    adapterContractVersion: 1 as const,
    payloadKind: "agent-teams.repository-mutation.known-file-journal/v1" as const,
    state: input.state,
    journal: input.journal,
    payloadDigest
  };
}

export function compileKnownFileTransactionEnvelope(input: {
  readonly ownerArtifact: KnownFileTransactionEnvelopeV1["ownerArtifact"];
  readonly kernelArtifact: KnownFileTransactionEnvelopeV1["kernelArtifact"];
  readonly journal: KnownFileTransactionJournalV1;
  readonly state: KnownFileTransactionEnvelopeV1["state"];
}): KnownFileTransactionEnvelopeV1 {
  assertJournal(input.journal);
  for (const artifact of [input.ownerArtifact, input.kernelArtifact]) {
    if (!SHA256.test(artifact.buildIdentity) || artifact.name.length === 0 || artifact.version.length === 0) {
      throw new KnownFileTransactionEnvelopeError("Known-file transaction artifact identity is invalid.");
    }
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
    "adapterContractVersion", "envelopeDigest", "format", "journal", "kernelArtifact",
    "operationKind", "ownerArtifact", "payloadDigest", "payloadKind", "recoveryHandler",
    "schemaVersion", "state"
  ], "Known-file transaction envelope");
  const ownerArtifact = record(envelope["ownerArtifact"], "Known-file owner artifact identity");
  const kernelArtifact = record(envelope["kernelArtifact"], "Known-file kernel artifact identity");
  const recovery = record(envelope["recoveryHandler"], "Known-file recovery handler");
  exactKeys(ownerArtifact, ["buildIdentity", "name", "version"], "Known-file owner artifact identity");
  exactKeys(kernelArtifact, ["buildIdentity", "name", "version"], "Known-file kernel artifact identity");
  exactKeys(recovery, ["contractVersion", "id"], "Known-file recovery handler");
  if (envelope["schemaVersion"] !== 6 ||
    envelope["format"] !== "agent-teams.repository-mutation.transaction-envelope/v1" ||
    envelope["operationKind"] !== "known-file-transaction" ||
    envelope["adapterContractVersion"] !== 1 ||
    envelope["payloadKind"] !== "agent-teams.repository-mutation.known-file-journal/v1" ||
    !["APPLYING", "COMMITTED"].includes(String(envelope["state"])) ||
    recovery["id"] !== "agent-teams.repository-mutation.known-file/v1" ||
    recovery["contractVersion"] !== 1 ||
    [ownerArtifact, kernelArtifact].some((artifact) =>
      typeof artifact["name"] !== "string" || typeof artifact["version"] !== "string" ||
      !SHA256.test(String(artifact["buildIdentity"])))) {
    throw new KnownFileTransactionEnvelopeError("Known-file transaction envelope binding is invalid.");
  }
  assertJournal(envelope["journal"]);
  const reconstructed = compileKnownFileTransactionEnvelope({
    ownerArtifact: ownerArtifact as unknown as KnownFileTransactionEnvelopeV1["ownerArtifact"],
    kernelArtifact: kernelArtifact as unknown as KnownFileTransactionEnvelopeV1["kernelArtifact"],
    journal: envelope["journal"],
    state: envelope["state"] as KnownFileTransactionEnvelopeV1["state"]
  });
  if (canonicalJson(reconstructed as unknown as CanonicalJsonValue) !==
    canonicalJson(value as CanonicalJsonValue)) {
    throw new KnownFileTransactionEnvelopeError("Known-file transaction envelope is non-canonical or tampered.");
  }
}

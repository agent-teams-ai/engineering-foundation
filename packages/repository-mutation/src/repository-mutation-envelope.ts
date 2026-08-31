import { TextDecoder } from "node:util";

import {
  canonicalJson,
  sha256Json,
  type CanonicalJsonValue
} from "./canonical-json.js";
import { parseStrictJson } from "./strict-json.js";

export const REPOSITORY_MUTATION_ENVELOPE_FORMAT =
  "agent-teams.repository-mutation.transaction-envelope/v1" as const;

const maximumEnvelopeBytes = 32 * 1024 * 1024;
const maximumDepth = 64;
const maximumEntries = 100_000;
const maximumStringLength = 1024 * 1024;
const maximumIdentifierLength = 256;
const maximumArtifactFieldLength = 1024;
const sha256 = /^sha256:[0-9a-f]{64}$/u;
const identifier = /^[\x21-\x7e]+$/u;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface RepositoryMutationArtifactIdentity {
  readonly name: string;
  readonly version: string;
  readonly buildIdentity: `sha256:${string}`;
}

export interface RepositoryMutationEnvelope {
  readonly schemaVersion: 6;
  readonly format: typeof REPOSITORY_MUTATION_ENVELOPE_FORMAT;
  readonly operationKind: string;
  readonly recoveryHandler: {
    readonly id: string;
    readonly contractVersion: number;
  };
  readonly ownerArtifact: RepositoryMutationArtifactIdentity;
  readonly kernelArtifact: RepositoryMutationArtifactIdentity;
  readonly adapterContractVersion: number;
  readonly payloadKind: string;
  readonly state: string;
  readonly payload: CanonicalJsonValue;
  readonly payloadDigest: `sha256:${string}`;
  readonly envelopeDigest: `sha256:${string}`;
}

export type CompileRepositoryMutationEnvelopeInput = Omit<
  RepositoryMutationEnvelope,
  "envelopeDigest" | "format" | "payloadDigest" | "schemaVersion"
>;

export class RepositoryMutationEnvelopeError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryMutationEnvelopeError";
  }
}

function fail(message: string): never {
  throw new RepositoryMutationEnvelopeError(message);
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${subject} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  subject: string
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
    (keys as string[]).toSorted().join("\0") !== [...expected].toSorted().join("\0") ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true;
    })) {
    fail(`${subject} has unknown or missing fields.`);
  }
}

function boundedIdentifier(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0 ||
    value.length > maximumIdentifierLength || !identifier.test(value) ||
    value.normalize("NFC") !== value) {
    fail(`${subject} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${subject} must be a positive safe integer.`);
  }
  return value as number;
}

function artifact(value: unknown, subject: string): RepositoryMutationArtifactIdentity {
  const candidate = record(value, subject);
  exactKeys(candidate, ["buildIdentity", "name", "version"], subject);
  if (typeof candidate["name"] !== "string" || candidate["name"].length === 0 ||
    candidate["name"].length > maximumArtifactFieldLength ||
    typeof candidate["version"] !== "string" || candidate["version"].length === 0 ||
    candidate["version"].length > maximumArtifactFieldLength ||
    candidate["name"].normalize("NFC") !== candidate["name"] ||
    candidate["version"].normalize("NFC") !== candidate["version"] ||
    !sha256.test(String(candidate["buildIdentity"]))) {
    fail(`${subject} is invalid.`);
  }
  return {
    name: candidate["name"],
    version: candidate["version"],
    buildIdentity: candidate["buildIdentity"] as `sha256:${string}`
  };
}

function appendCanonicalArray(
  candidate: unknown[],
  depth: number,
  pending: { readonly value: unknown; readonly depth: number }[]
): number {
  const keys = Reflect.ownKeys(candidate);
  if (Object.getPrototypeOf(candidate) !== Array.prototype ||
    keys.some((key) => typeof key !== "string" ||
      (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))) ||
    keys.length !== candidate.length + 1) {
    fail("Repository Mutation payload contains a noncanonical array.");
  }
  for (let index = candidate.length - 1; index >= 0; index -= 1) {
    if (!Object.hasOwn(candidate, index)) {
      fail("Repository Mutation payload arrays must be dense.");
    }
    pending.push({ value: candidate[index], depth: depth + 1 });
  }
  return candidate.length;
}

function appendCanonicalObject(
  candidate: object,
  depth: number,
  pending: { readonly value: unknown; readonly depth: number }[]
): number {
  if (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null) {
    fail("Repository Mutation payload objects must have a plain or null prototype.");
  }
  const keys = Reflect.ownKeys(candidate);
  for (const key of keys) {
    if (typeof key !== "string" || key.length > maximumStringLength || key.normalize("NFC") !== key) {
      fail("Repository Mutation payload contains a noncanonical object key.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail("Repository Mutation payload objects must contain enumerable own data properties.");
    }
    pending.push({ value: descriptor.value, depth: depth + 1 });
  }
  return keys.length;
}

function canonicalPayload(value: unknown): CanonicalJsonValue {
  let entries = 0;
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 0 }
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > maximumDepth) {fail("Repository Mutation payload is too deep.");}
    if (typeof current.value === "string") {
      if (current.value.length > maximumStringLength) {
        fail("Repository Mutation payload contains an oversized string.");
      }
      continue;
    }
    if (current.value === null || typeof current.value === "boolean") {continue;}
    if (typeof current.value === "number") {
      if (!Number.isSafeInteger(current.value) || Object.is(current.value, -0)) {
        fail("Repository Mutation payload contains a noncanonical number.");
      }
      continue;
    }
    if (typeof current.value !== "object") {
      fail("Repository Mutation payload is outside the canonical JSON data model.");
    }
    const candidate = current.value as object;
    if (Array.isArray(candidate)) {
      entries += appendCanonicalArray(candidate, current.depth, pending);
    } else {
      entries += appendCanonicalObject(candidate, current.depth, pending);
    }
    if (entries > maximumEntries) {fail("Repository Mutation payload has too many entries.");}
  }
  // The leaf canonicalizer is the sole canonical serialization and digest authority.
  canonicalJson(value as CanonicalJsonValue);
  return value as CanonicalJsonValue;
}

function clone(value: CanonicalJsonValue): CanonicalJsonValue {
  if (value === null || typeof value !== "object") {return value;}
  if (Array.isArray(value)) {return value.map((item) => clone(item));}
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function deepFreeze<T>(value: T): T {
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) {pending.push(value);}
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null && !Object.isFrozen(child)) {pending.push(child);}
    }
    Object.freeze(current);
  }
  return value;
}

function compile(value: Record<string, unknown>): RepositoryMutationEnvelope {
  const ownerArtifact = artifact(value["ownerArtifact"], "Owner artifact identity");
  const kernelArtifact = artifact(value["kernelArtifact"], "Kernel artifact identity");
  const recoveryHandler = record(value["recoveryHandler"], "Recovery handler");
  exactKeys(recoveryHandler, ["contractVersion", "id"], "Recovery handler");
  const payload = clone(canonicalPayload(value["payload"]));
  const body = {
    schemaVersion: 6 as const,
    format: REPOSITORY_MUTATION_ENVELOPE_FORMAT,
    operationKind: boundedIdentifier(value["operationKind"], "Operation kind"),
    recoveryHandler: {
      id: boundedIdentifier(recoveryHandler["id"], "Recovery handler id"),
      contractVersion: positiveInteger(recoveryHandler["contractVersion"], "Recovery handler contract version")
    },
    ownerArtifact,
    kernelArtifact,
    adapterContractVersion: positiveInteger(value["adapterContractVersion"], "Adapter contract version"),
    payloadKind: boundedIdentifier(value["payloadKind"], "Payload kind"),
    state: boundedIdentifier(value["state"], "Envelope state"),
    payload,
    payloadDigest: sha256Json(payload)
  };
  return deepFreeze({
    ...body,
    envelopeDigest: sha256Json(body as unknown as CanonicalJsonValue)
  });
}

export function compileRepositoryMutationEnvelope(
  input: CompileRepositoryMutationEnvelopeInput
): RepositoryMutationEnvelope {
  const candidate = record(input, "Repository Mutation envelope input");
  exactKeys(candidate, [
    "adapterContractVersion", "kernelArtifact", "operationKind", "ownerArtifact",
    "payload", "payloadKind", "recoveryHandler", "state"
  ], "Repository Mutation envelope input");
  return compile(candidate);
}

function assertBoundedSourceDepth(source: string): void {
    let depth = 0;
    let inString = false;
    let escaped = false;
  for (const character of source) {
      if (inString) {
        if (escaped) {escaped = false;}
        else if (character === "\\") {escaped = true;}
        else if (character === '"') {inString = false;}
      } else if (character === '"') {inString = true;}
      else if (character === "{" || character === "[") {
        depth += 1;
        if (depth > maximumDepth + 1) {fail("Repository Mutation envelope is too deep.");}
      } else if (character === "}" || character === "]") {depth -= 1;}
  }
}

export function parseRepositoryMutationEnvelope(bytes: Uint8Array): RepositoryMutationEnvelope {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximumEnvelopeBytes) {
    fail("Repository Mutation envelope byte length is invalid.");
  }
  let value: unknown;
  try {
    const source = strictUtf8.decode(bytes);
    assertBoundedSourceDepth(source);
    value = parseStrictJson(source);
  } catch (error) {
    if (error instanceof RepositoryMutationEnvelopeError) {throw error;}
    throw new RepositoryMutationEnvelopeError("Repository Mutation envelope is not strict UTF-8 JSON.", { cause: error });
  }
  const candidate = record(value, "Repository Mutation envelope");
  exactKeys(candidate, [
    "adapterContractVersion", "envelopeDigest", "format", "kernelArtifact",
    "operationKind", "ownerArtifact", "payload", "payloadDigest", "payloadKind",
    "recoveryHandler", "schemaVersion", "state"
  ], "Repository Mutation envelope");
  if (candidate["schemaVersion"] !== 6 || candidate["format"] !== REPOSITORY_MUTATION_ENVELOPE_FORMAT ||
    !sha256.test(String(candidate["payloadDigest"])) || !sha256.test(String(candidate["envelopeDigest"]))) {
    fail("Repository Mutation envelope binding is invalid.");
  }
  const compiled = compile(candidate);
  if (compiled.payloadDigest !== candidate["payloadDigest"] ||
    compiled.envelopeDigest !== candidate["envelopeDigest"]) {
    fail("Repository Mutation envelope digest is invalid.");
  }
  return compiled;
}

export function assertRepositoryMutationArtifactBindings(
  envelope: RepositoryMutationEnvelope,
  expectedOwner: RepositoryMutationArtifactIdentity,
  expectedKernel: RepositoryMutationArtifactIdentity
): void {
  const owner = artifact(expectedOwner, "Expected owner artifact identity");
  const kernel = artifact(expectedKernel, "Expected kernel artifact identity");
  const fields = ["name", "version", "buildIdentity"] as const;
  if (fields.some((field) => envelope.ownerArtifact[field] !== owner[field] ||
    envelope.kernelArtifact[field] !== kernel[field])) {
    fail("The exact owner and kernel artifacts that created the Repository Mutation envelope are required.");
  }
}

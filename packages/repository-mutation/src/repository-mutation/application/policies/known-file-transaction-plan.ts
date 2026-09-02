import {
  canonicalJson,
  sha256Bytes,
  sha256Json,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
import type {
  CompileKnownFileTransactionPlanInput,
  KnownFileImageV1,
  KnownFileTransactionOperationInput,
  KnownFileTransactionOperationV1,
  KnownFileTransactionPlanV1
} from "../model/known-file-transaction.js";
import {
  findPortableRepositoryPathCollision,
  portableRepositoryPathProblem
} from "../model/repository-path.js";

const MAXIMUM_OPERATION_COUNT = 32;
const MAXIMUM_FILE_BYTES = 8 * 1024 * 1024;
// Keep the canonical Base64 journal comfortably below its separate 32 MiB
// serialized limit. Raw transaction evidence expands by at least 4/3.
const MAXIMUM_TRANSACTION_BYTES = 16 * 1024 * 1024;
const MAXIMUM_BASE64_FILE_LENGTH = 4 * Math.ceil(MAXIMUM_FILE_BYTES / 3);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export class KnownFileTransactionPlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KnownFileTransactionPlanError";
  }
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertInertInputGraph(value: unknown, subject: string, depth = 0): void {
  if (depth > 8) {
    throw new KnownFileTransactionPlanError(`${subject} is too deeply nested.`);
  }
  if (value instanceof Uint8Array || value === null || typeof value !== "object") {return;}
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new KnownFileTransactionPlanError(`${subject} must contain only plain data.`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || (Array.isArray(value) && key === "length")) {continue;}
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new KnownFileTransactionPlanError(`${subject} must contain only enumerable data properties.`);
    }
    assertInertInputGraph(descriptor.value, subject, depth + 1);
  }
}

function inertInputOperations(input: CompileKnownFileTransactionPlanInput): readonly KnownFileTransactionOperationInput[] {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 1) {
    throw new KnownFileTransactionPlanError("Known-file transaction input is not one plain operations record.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, "operations");
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable ||
    !Array.isArray(descriptor.value) || descriptor.value.length > MAXIMUM_OPERATION_COUNT) {
    throw new KnownFileTransactionPlanError(
      `A transaction supports at most ${MAXIMUM_OPERATION_COUNT} operations.`
    );
  }
  assertInertInputGraph(descriptor.value, "Known-file transaction operations");
  return descriptor.value as readonly KnownFileTransactionOperationInput[];
}

function assertMode(mode: number, subject: string): void {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
    throw new KnownFileTransactionPlanError(
      `${subject} mode must be one portable permission value.`
    );
  }
}

function assertBytes(bytes: Uint8Array, subject: string): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new KnownFileTransactionPlanError(`${subject} bytes must be Uint8Array.`);
  }
  if (bytes.byteLength > MAXIMUM_FILE_BYTES) {
    throw new KnownFileTransactionPlanError(
      `${subject} exceeds the ${MAXIMUM_FILE_BYTES} byte limit.`
    );
  }
}

function image(bytes: Uint8Array, mode: number, subject: string): KnownFileImageV1 {
  assertBytes(bytes, subject);
  assertMode(mode, subject);
  const copied = Buffer.from(bytes);
  return Object.freeze({
    contentBase64: copied.toString("base64"),
    digest: sha256Bytes(copied),
    mode,
    size: copied.byteLength
  });
}

function compareImages(left: KnownFileImageV1, right: KnownFileImageV1): number {
  return binaryCompare(
    canonicalJson(left as unknown as CanonicalJsonValue),
    canonicalJson(right as unknown as CanonicalJsonValue)
  );
}

function compileOperation(
  operation: KnownFileTransactionOperationInput
): KnownFileTransactionOperationV1 {
  const problem = portableRepositoryPathProblem(operation.path);
  if (problem !== undefined) {
    throw new KnownFileTransactionPlanError(
      `Operation path ${operation.path} is not portable: ${problem}.`
    );
  }
  if (operation.path.normalize("NFC") !== operation.path) {
    throw new KnownFileTransactionPlanError(
      `Operation path ${operation.path} must use NFC normalization.`
    );
  }
  if (operation.path === ".agent-teams-local" ||
    operation.path.startsWith(".agent-teams-local/")) {
    throw new KnownFileTransactionPlanError(
      `Operation path ${operation.path} overlaps Foundation's internal state namespace.`
    );
  }
  if (operation.precondition.state === "absent") {
    return Object.freeze({
      path: operation.path,
      precondition: Object.freeze({ state: "absent" }),
      postimage: image(
        operation.postimage.bytes,
        operation.postimage.mode ?? 0o644,
        `${operation.path} postimage`
      )
    });
  }
  if (operation.precondition.acceptedPreimages.length === 0) {
    throw new KnownFileTransactionPlanError(
      `${operation.path} replacement requires at least one exact preimage.`
    );
  }
  if (operation.precondition.acceptedPreimages.length > 16) {
    throw new KnownFileTransactionPlanError(
      `${operation.path} replacement exceeds the 16 preimage limit.`
    );
  }
  const postimageMode = operation.postimage.mode;
  if (postimageMode === undefined) {
    throw new KnownFileTransactionPlanError(
      `${operation.path} replacement requires an exact file mode.`
    );
  }
  assertMode(postimageMode, `${operation.path} postimage`);
  const acceptedPreimages = operation.precondition.acceptedPreimages
    .map((entry, index) => {
      if (entry.mode !== postimageMode) {
        throw new KnownFileTransactionPlanError(
          `${operation.path} replacement must preserve the exact file mode.`
        );
      }
      return image(entry.bytes, entry.mode, `${operation.path} preimage ${index}`);
    })
    .toSorted(compareImages);
  for (let index = 1; index < acceptedPreimages.length; index += 1) {
    if (
      canonicalJson(acceptedPreimages[index - 1] as unknown as CanonicalJsonValue) ===
      canonicalJson(acceptedPreimages[index] as unknown as CanonicalJsonValue)
    ) {
      throw new KnownFileTransactionPlanError(
        `${operation.path} replacement contains a duplicate exact preimage.`
      );
    }
  }
  const postimage = image(
    operation.postimage.bytes,
    postimageMode,
    `${operation.path} postimage`
  );
  return Object.freeze({
    path: operation.path,
    precondition: Object.freeze({
      state: "known-file",
      acceptedPreimages: Object.freeze(acceptedPreimages)
    }),
    postimage
  });
}

function planBody(operations: readonly KnownFileTransactionOperationV1[]) {
  return {
    schemaVersion: 1 as const,
    protocol: "agent-teams.repository-mutation.known-file/v1" as const,
    operations
  };
}

export function compileKnownFileTransactionPlan(
  input: CompileKnownFileTransactionPlanInput
): KnownFileTransactionPlanV1 {
  const inputOperations = inertInputOperations(input);
  const operations = inputOperations.map(compileOperation).toSorted((left, right) =>
    binaryCompare(left.path, right.path)
  );
  const collision = findPortableRepositoryPathCollision(
    operations.map(({ path }) => path)
  );
  if (collision !== undefined) {
    throw new KnownFileTransactionPlanError(
      `Operation paths collide portably: ${collision.first} and ${collision.second}.`
    );
  }
  for (let index = 1; index < operations.length; index += 1) {
    const ancestor = operations[index - 1]!.path;
    const descendant = operations[index]!.path;
    if (descendant.startsWith(`${ancestor}/`)) {
      throw new KnownFileTransactionPlanError(
        `Operation paths overlap as ancestor and descendant: ${ancestor} and ${descendant}.`
      );
    }
  }
  const totalBytes = operations.reduce(
    (total, operation) => total + operation.postimage.size +
      (operation.precondition.state === "known-file"
        ? operation.precondition.acceptedPreimages.reduce(
            (preimageTotal, entry) => preimageTotal + entry.size,
            0
          )
        : 0),
    0
  );
  if (totalBytes > MAXIMUM_TRANSACTION_BYTES) {
    throw new KnownFileTransactionPlanError(
      `Transaction evidence exceeds the ${MAXIMUM_TRANSACTION_BYTES} byte limit.`
    );
  }
  const frozenOperations = Object.freeze(operations);
  const body = planBody(frozenOperations);
  const planDigest = sha256Json({
    domain: "agent-teams.repository-mutation.known-file-plan/v1",
    body
  } as unknown as CanonicalJsonValue);
  if (!SHA256.test(planDigest)) {
    throw new KnownFileTransactionPlanError("Compiled Plan digest is invalid.");
  }
  return Object.freeze({ ...body, planDigest });
}

export function assertKnownFileTransactionPlan(
  value: unknown
): asserts value is KnownFileTransactionPlanV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.get(value, "schemaVersion") !== 1 ||
    Reflect.get(value, "protocol") !== "agent-teams.repository-mutation.known-file/v1" ||
    !SHA256.test(String(Reflect.get(value, "planDigest"))) ||
    !Array.isArray(Reflect.get(value, "operations"))
  ) {
    throw new KnownFileTransactionPlanError("Known-file transaction Plan is invalid.");
  }
  const operations = Reflect.get(value, "operations") as unknown[];
  const reconstructed = compileKnownFileTransactionPlan({
    operations: operations.map((candidate): KnownFileTransactionOperationInput => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new KnownFileTransactionPlanError("Known-file transaction operation is invalid.");
      }
      const path = String(Reflect.get(candidate, "path"));
      const precondition: unknown = Reflect.get(candidate, "precondition");
      const postimage = readImage(Reflect.get(candidate, "postimage"), `${path} postimage`);
      if (typeof precondition !== "object" || precondition === null || Array.isArray(precondition)) {
        throw new KnownFileTransactionPlanError(`${path} precondition is invalid.`);
      }
      if (Reflect.get(precondition, "state") === "absent") {
        return { path, precondition: { state: "absent" }, postimage: {
          bytes: postimage.bytes,
          mode: postimage.mode
        } };
      }
      const accepted: unknown = Reflect.get(precondition, "acceptedPreimages");
      if (Reflect.get(precondition, "state") !== "known-file" || !Array.isArray(accepted)) {
        throw new KnownFileTransactionPlanError(`${path} precondition is invalid.`);
      }
      return {
        path,
        precondition: {
          state: "known-file",
          acceptedPreimages: accepted.map((entry, index) => {
            const parsed = readImage(entry, `${path} preimage ${index}`);
            return { bytes: parsed.bytes, mode: parsed.mode };
          })
        },
        postimage: { bytes: postimage.bytes, mode: postimage.mode }
      };
    })
  });
  if (
    canonicalJson(reconstructed as unknown as CanonicalJsonValue) !==
    canonicalJson(value as unknown as CanonicalJsonValue)
  ) {
    throw new KnownFileTransactionPlanError(
      "Known-file transaction Plan is not canonical or has an invalid digest."
    );
  }
}

function readImage(
  value: unknown,
  subject: string
): KnownFileImageV1 & { readonly bytes: Buffer } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KnownFileTransactionPlanError(`${subject} is invalid.`);
  }
  const contentBase64: unknown = Reflect.get(value, "contentBase64");
  const digest: unknown = Reflect.get(value, "digest");
  const mode: unknown = Reflect.get(value, "mode");
  const size: unknown = Reflect.get(value, "size");
  if (
    typeof contentBase64 !== "string" ||
    contentBase64.length > MAXIMUM_BASE64_FILE_LENGTH ||
    typeof digest !== "string" ||
    !SHA256.test(digest) ||
    typeof mode !== "number" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 || size > MAXIMUM_FILE_BYTES
  ) {
    throw new KnownFileTransactionPlanError(`${subject} is invalid.`);
  }
  const bytes = Buffer.from(contentBase64, "base64");
  const canonicalBase64 = bytes.toString("base64");
  const expected = image(bytes, mode, subject);
  if (
    contentBase64 !== canonicalBase64 ||
    expected.digest !== digest ||
    expected.size !== size
  ) {
    throw new KnownFileTransactionPlanError(`${subject} bytes or digest are invalid.`);
  }
  return Object.freeze({ ...expected, bytes });
}

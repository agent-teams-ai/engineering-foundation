import { KnownFileTransactionPlanError } from "../model/known-file-transaction-error.js";
import type { KnownFileTransactionOperationInput } from "../model/known-file-transaction.js";

export const maximumKnownFileOperations = 32;
export const maximumKnownFilePreimages = 16;
export const maximumKnownFileImageBytes = 8 * 1024 * 1024;
const maximumKnownFilePlanBytes = 16 * 1024 * 1024;

/** Default modes are resolved; only the closed compiler vocabulary crosses admission. */
export interface AdmittedKnownFileOperation {
  readonly path: string;
  readonly precondition: KnownFileTransactionOperationInput["precondition"];
  readonly postimage: { readonly bytes: Uint8Array; readonly mode: number };
}

function invalid(subject: string): never {
  throw new KnownFileTransactionPlanError(
    `${subject} must contain only enumerable data properties and plain data.`,
  );
}

export function knownFileInputRecord(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(subject);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(subject);
  }
  const result: Record<string, unknown> = { __proto__: null };
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      invalid(subject);
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function assertKnownFileKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  subject: string,
): void {
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new KnownFileTransactionPlanError(`${subject} has unknown or missing fields.`);
  }
}

export function knownFileInputArray(
  value: unknown,
  maximum: number,
  subject: string,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(subject);
  }
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || length > maximum) {
    throw new KnownFileTransactionPlanError(`${subject} supports at most ${maximum} entries.`);
  }
  if (Reflect.ownKeys(value).length !== length + 1) {
    invalid(subject);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      invalid(subject);
    }
    result.push(descriptor.value);
  }
  return result;
}

// Native accessors read view geometry without caller getters, iterators or species.
// Intrinsics and executable Proxies are outside the supported input contract.
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype);
function nativeViewField(view: Uint8Array, name: "buffer" | "byteOffset" | "byteLength"): unknown {
  return typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(typedArrayPrototype, name)?.get?.call(view);
}

function nativeByteView(value: unknown, subject: string): Uint8Array {
  if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value)) {
    throw new KnownFileTransactionPlanError(`${subject} bytes must be Uint8Array.`);
  }
  const buffer = nativeViewField(value, "buffer");
  const offset = nativeViewField(value, "byteOffset");
  const length = nativeViewField(value, "byteLength");
  if (
    !(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer) ||
    typeof offset !== "number" ||
    typeof length !== "number"
  ) {
    invalid(subject);
  }
  return new Uint8Array(buffer, offset, length);
}

function assertInertCompilerValue(value: unknown, depth = 0): void {
  if (depth > 8) {
    throw new KnownFileTransactionPlanError(
      "Known-file transaction operations is too deeply nested.",
    );
  }
  if (value instanceof Uint8Array && ArrayBuffer.isView(value)) {
    return;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return;
  }
  const entries = Array.isArray(value)
    ? knownFileInputArray(value, Number.MAX_SAFE_INTEGER, "Known-file transaction operations")
    : Object.values(knownFileInputRecord(value, "Known-file transaction operations"));
  for (const entry of entries) {
    assertInertCompilerValue(entry, depth + 1);
  }
}

export function chargeKnownFileImage(
  budget: { bytes: number },
  size: number,
  subject: string,
): void {
  if (size > maximumKnownFileImageBytes) {
    throw new KnownFileTransactionPlanError(
      `${subject} exceeds the ${maximumKnownFileImageBytes} byte limit.`,
    );
  }
  budget.bytes += size;
  if (budget.bytes > maximumKnownFilePlanBytes) {
    throw new KnownFileTransactionPlanError(
      `Transaction evidence exceeds the ${maximumKnownFilePlanBytes} byte limit.`,
    );
  }
}

export function knownFileMode(value: unknown, subject: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0o777) {
    throw new KnownFileTransactionPlanError(
      `${subject} mode must be one portable permission value.`,
    );
  }
  return value;
}

function compilerImage(
  value: unknown,
  budget: { bytes: number },
  subject: string,
  defaultMode?: number,
) {
  const record = knownFileInputRecord(value, subject);
  const bytes = nativeByteView(record["bytes"], subject);
  chargeKnownFileImage(budget, bytes.byteLength, subject);
  const mode = knownFileMode(record["mode"] ?? defaultMode, subject);
  return { bytes, mode };
}

function compilerOperation(value: unknown, budget: { bytes: number }): AdmittedKnownFileOperation {
  const operation = knownFileInputRecord(value, "Known-file transaction operation");
  const path = operation["path"];
  if (typeof path !== "string") {
    throw new KnownFileTransactionPlanError("Operation path must be a string.");
  }
  const precondition = knownFileInputRecord(operation["precondition"], `${path} precondition`);
  if (precondition["state"] === "absent") {
    return {
      path,
      precondition: { state: "absent" },
      postimage: compilerImage(operation["postimage"], budget, `${path} postimage`, 0o644),
    };
  }
  if (precondition["state"] !== "known-file") {
    throw new KnownFileTransactionPlanError(`${path} precondition is invalid.`);
  }
  const accepted = knownFileInputArray(
    precondition["acceptedPreimages"],
    maximumKnownFilePreimages,
    `${path} replacement preimages`,
  );
  if (accepted.length === 0) {
    throw new KnownFileTransactionPlanError(
      `${path} replacement requires at least one exact preimage.`,
    );
  }
  const postimage = compilerImage(operation["postimage"], budget, `${path} postimage`);
  return {
    path,
    precondition: {
      state: "known-file",
      acceptedPreimages: accepted.map((entry, index) =>
        compilerImage(entry, budget, `${path} preimage ${index}`),
      ),
    },
    postimage,
  };
}

export function admitKnownFileCompileInput(value: unknown): readonly AdmittedKnownFileOperation[] {
  const record = knownFileInputRecord(
    value,
    "Known-file transaction input plain operations record",
  );
  assertKnownFileKeys(
    record,
    ["operations"],
    "Known-file transaction input plain operations record",
  );
  const values = knownFileInputArray(
    record["operations"],
    maximumKnownFileOperations,
    "A transaction",
  );
  const budget = { bytes: 0 };
  // Preflight known counts and native byte lengths before traversing inert extra
  // data or making any image copies. The owned native views invoke no caller code.
  const operations = values.map((entry) => compilerOperation(entry, budget));
  assertInertCompilerValue(values);
  return operations;
}

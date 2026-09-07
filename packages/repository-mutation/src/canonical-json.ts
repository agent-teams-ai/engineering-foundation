import { createHash } from "node:crypto";

export type CanonicalJsonPrimitive = boolean | null | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export class CanonicalJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertCanonicalString(value: string): void {
  if (value.normalize("NFC") !== value) {
    throw new CanonicalJsonError(
      "Canonical JSON strings must use NFC normalization."
    );
  }
}

function invalidContainer(message: string): never {
  throw new CanonicalJsonError(`Canonical JSON ${message}.`);
}

function enterContainer(
  value: object,
  ancestors: WeakSet<object>
): () => void {
  if (ancestors.has(value)) {
    invalidContainer("must not contain cycles");
  }
  ancestors.add(value);
  return () => ancestors.delete(value);
}

function canonicalizeArray(
  value: readonly CanonicalJsonValue[],
  ancestors: WeakSet<object>
): string {
  const leave = enterContainer(value, ancestors);
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      invalidContainer("arrays must use the intrinsic Array prototype");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))
      )
    ) {
      invalidContainer("arrays must not contain extra or symbolic properties");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number"
    ) {
      invalidContainer("arrays must expose an own data length");
    }
    const length = lengthDescriptor.value;
    for (const key of keys) {
      if (
        typeof key === "string" &&
        key !== "length" &&
        BigInt(key) >= BigInt(length)
      ) {
        invalidContainer("array indexes must be within the declared length");
      }
    }
    const items: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalidContainer("arrays must be dense own-data sequences");
      }
      items.push(canonicalize(descriptor.value as CanonicalJsonValue, ancestors));
    }
    return `[${items.join(",")}]`;
  } finally {
    leave();
  }
}

function canonicalizeObject(
  candidate: object,
  ancestors: WeakSet<object>
): string {
  const prototype: unknown = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidContainer("objects must have a plain or null prototype");
  }
  const leave = enterContainer(candidate, ancestors);
  try {
    const entries = Reflect.ownKeys(candidate).map((key) => {
      if (typeof key !== "string") {
        invalidContainer("objects must not contain symbolic properties");
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalidContainer("objects must contain only enumerable own-data properties");
      }
      assertCanonicalString(key);
      return [key, descriptor.value as CanonicalJsonValue] as const;
    });
    entries.sort(([left], [right]) => compareStrings(left, right));
    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalize(item, ancestors)}`
      )
      .join(",")}}`;
  } finally {
    leave();
  }
}

function canonicalize(
  value: CanonicalJsonValue,
  ancestors: WeakSet<object>
): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertCanonicalString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      !Number.isSafeInteger(value)
    ) {
      throw new CanonicalJsonError(
        "Canonical JSON numbers must be finite safe integers."
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    invalidContainer("values must use the closed JSON data model");
  }
  if (Array.isArray(value)) {
    return canonicalizeArray(value, ancestors);
  }
  return canonicalizeObject(value, ancestors);
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return canonicalize(value, new WeakSet<object>());
}

export function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function sha256Json(value: CanonicalJsonValue): `sha256:${string}` {
  return sha256Text(canonicalJson(value));
}

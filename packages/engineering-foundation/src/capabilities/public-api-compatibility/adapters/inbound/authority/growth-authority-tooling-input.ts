import { types } from "node:util";
import {
  invalid,
  object,
} from "../../../application/policies/validate-growth-authority-primitives.js";
import { growthCanonicalJson } from "../../../application/policies/normalize-growth-observation.js";
import { parseStrictJsonResponse } from "../../outbound/reviewrouter/strict-json-response.js";
const maximumBytes = 32 * 1024 * 1024;
const encoder = new TextEncoder();

/** A descriptor-only snapshot. No producer getter, proxy trap or custom method is invoked. */
function snapshot(value: unknown, budget: { nodes: number; units: number }, depth = 0): unknown {
  if (++budget.nodes > 1_000_000 || depth > 64 || types.isProxy(value)) {
    invalid("growth-authority-tooling-input-unsafe");
  }
  if (typeof value === "string") {
    budget.units += value.length;
    if (budget.units > maximumBytes) {
      invalid("growth-authority-tooling-input-budget-exhausted");
    }
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  if (typeof value !== "object") {
    invalid("growth-authority-tooling-input-unsafe");
  }
  const isArray = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    invalid("growth-authority-tooling-input-unsafe");
  }
  return isArray ? snapshotArray(value, budget, depth) : snapshotObject(value, budget, depth);
}
function snapshotArray(
  value: object,
  budget: { nodes: number; units: number },
  depth: number,
): unknown[] {
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    keys.length !== (length as number) + 1
  ) {
    invalid("growth-authority-tooling-input-unsafe");
  }
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      invalid("growth-authority-tooling-input-unsafe");
    }
    result.push(snapshot(descriptor.value, budget, depth + 1));
  }
  return result;
}
function snapshotObject(
  value: object,
  budget: { nodes: number; units: number },
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key.normalize("NFC") !== key) {
      invalid("growth-authority-tooling-input-unsafe");
    }
    budget.units += key.length;
    if (budget.units > maximumBytes) {
      invalid("growth-authority-tooling-input-budget-exhausted");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      invalid("growth-authority-tooling-input-unsafe");
    }
    Object.defineProperty(result, key, {
      value: snapshot(descriptor.value, budget, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function input(value: unknown): unknown {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length > maximumBytes || encoder.encode(value).byteLength > maximumBytes) {
      invalid("growth-authority-tooling-input-budget-exhausted");
    }
    parsed = parseStrictJsonResponse(value, 64);
  } else if (intrinsicByteLength(value) !== null) {
    const bytes = copyBytes(value);
    parsed = parseStrictJsonResponse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), 64);
  }
  const safe = snapshot(parsed, { nodes: 0, units: 0 });
  if (encoder.encode(growthCanonicalJson(safe)).byteLength > maximumBytes) {
    invalid("growth-authority-tooling-input-budget-exhausted");
  }
  return safe;
}
export function optionsRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    types.isProxy(value) ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid("growth-authority-tooling-options-unsafe");
  }
  return object(value, keys, "growth-authority-tooling-options-unsafe");
}

function intrinsicByteLength(value: unknown): number | null {
  if (types.isProxy(value) || value === null || typeof value !== "object") {
    return null;
  }
  try {
    const length = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype),
      "byteLength",
    )?.get?.call(value) as unknown;
    return typeof length === "number" ? length : null;
  } catch {
    return null;
  }
}
export function copyBytes(value: unknown): Uint8Array {
  const length = intrinsicByteLength(value);
  if (length === null) {
    invalid("growth-authority-tooling-input-unsafe");
  }
  const source = value as Uint8Array; // Intrinsic typed-array brand was checked above.
  const prototype: unknown = Object.getPrototypeOf(source);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) {
    invalid("growth-authority-tooling-input-unsafe");
  }
  if (
    ["byteLength", "byteOffset", "buffer", "length"].some((key) => Object.hasOwn(source, key)) ||
    Object.hasOwn(source, Symbol.iterator)
  ) {
    invalid("growth-authority-tooling-input-unsafe");
  }
  if (typeof length !== "number" || length === 0 || length > maximumBytes) {
    invalid("growth-authority-tooling-input-budget-exhausted");
  }
  return Uint8Array.from(Uint8Array.prototype.values.call(source));
}

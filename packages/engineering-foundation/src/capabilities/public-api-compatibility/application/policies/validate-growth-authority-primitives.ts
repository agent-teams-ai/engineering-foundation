import type { GrowthDigest } from "../model/growth-observation.js";
import type { GrowthAuthoritySource } from "../model/growth-authority.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import { growthCanonicalJson } from "./normalize-growth-observation.js";
import { isExactVersion } from "../../../../semantic-version.js";

export function invalid(reason: string): never { throw new GrowthObservationInvariantError(reason); }
export function object(value: unknown, keys: readonly string[], reason = "growth-authority-contract-invalid"): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) { invalid(reason); }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) { invalid(reason); }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) { invalid(reason); }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) { invalid(reason); }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalid(reason);
  }
}
export function array(value: unknown, limit: number, reason: string): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) { invalid(reason); }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > limit) { invalid(reason); }
    const length = lengthDescriptor.value as number;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) { invalid(reason); }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) { invalid(reason); }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return invalid(reason);
  }
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) { invalid("growth-authority-text-invalid"); }
  return value;
}
export function digest(value: unknown): GrowthDigest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) { invalid("growth-authority-digest-invalid"); }
  return value as GrowthDigest;
}
export function commit(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) { invalid("growth-authority-source-invalid"); }
  return value;
}
export function source(value: unknown): GrowthAuthoritySource {
  const row = object(value, ["commit", "tree"]);
  return { commit: commit(row["commit"]), tree: commit(row["tree"]) };
}
export function date(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) { invalid("growth-authority-time-invalid"); }
  return result;
}
export function exact(left: unknown, right: unknown, reason: string): void {
  if (growthCanonicalJson(left) !== growthCanonicalJson(right)) { invalid(reason); }
}
export function integrity(value: unknown): string {
  const result = text(value);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(result)) { invalid("growth-authority-integrity-invalid"); }
  return result;
}
export function exactVersion(value: unknown): string {
  const result = text(value);
  if (!isExactVersion(result)) { invalid("growth-authority-version-invalid"); }
  return result;
}
export function repositoryPath(value: unknown): string {
  const result = text(value), segments = result.split("/");
  if (result.startsWith("/") || result.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    invalid("growth-authority-path-invalid");
  }
  return result;
}
export function member(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) { return undefined; }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) { return undefined; }
    if (!("value" in descriptor) || descriptor.enumerable !== true) { invalid("growth-authority-contract-invalid"); }
    return descriptor.value;
  } catch {
    return invalid("growth-authority-contract-invalid");
  }
}
export function uniqueMap<T>(values: readonly T[], key: (value: T) => string, reason: string): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) { invalid(reason); }
    result.set(identity, value);
  }
  return result;
}
export function custodyPath(pathValue: unknown): string {
  const result = repositoryPath(pathValue);
  if (result !== result.normalize("NFC") || /[\p{Cc}:%]/u.test(result)
    || result.split("/").some((part) => /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))) {
    invalid("growth-authority-path-invalid");
  }
  return result;
}

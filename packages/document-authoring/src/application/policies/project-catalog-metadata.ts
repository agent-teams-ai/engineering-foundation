import { compareBinaryStrings } from "../../binary-string-comparator.js";
import { canonicalJson } from "../../canonical-json.js";
import type {
  DocumentMetadataObject,
  DocumentMetadataValue
} from "../model/document-catalog.js";

const MAXIMUM_METADATA_DEPTH = 64;
const MAXIMUM_METADATA_CONTAINER_ITEMS = 10_000;
const MAXIMUM_METADATA_VALUES = 100_000;
const MAXIMUM_METADATA_JSON_BYTES = 1024 * 1024;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const NOT_SCALAR = Symbol("not-scalar");

export class CatalogMetadataProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogMetadataProjectionError";
  }
}

function invalidMetadata(message: string): never {
  throw new CatalogMetadataProjectionError(message);
}

function assertCanonicalString(value: string, subject: string): void {
  if (value.normalize("NFC") !== value) {
    invalidMetadata(`${subject} must use Unicode NFC.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        invalidMetadata(`${subject} must not contain lone UTF-16 surrogates.`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalidMetadata(`${subject} must not contain lone UTF-16 surrogates.`);
    }
  }
}

interface ProjectionBudget {
  values: number;
}

function countValue(budget: ProjectionBudget): void {
  budget.values += 1;
  if (budget.values > MAXIMUM_METADATA_VALUES) {
    invalidMetadata("Document metadata exceeds the value budget.");
  }
}

function projectScalar(
  value: unknown
): DocumentMetadataValue | typeof NOT_SCALAR {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    assertCanonicalString(value, "Document metadata string");
    return value;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      !Number.isSafeInteger(value) ||
      Object.is(value, -0)
    ) {
      invalidMetadata(
        "Document metadata numbers must be finite safe integers other than negative zero."
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    invalidMetadata("Document metadata must use the closed JSON data model.");
  }
  return NOT_SCALAR;
}

function ownDataKeys(value: object, array: boolean): readonly string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    invalidMetadata("Document metadata must not contain symbol keys.");
  }
  const stringKeys = keys as string[];
  if (array) {
    if (
      stringKeys.length !== (value as unknown[]).length + 1 ||
      stringKeys.some(
        (key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)
      )
    ) {
      invalidMetadata("Document metadata arrays must be dense and contain no extra properties.");
    }
  }
  const itemCount = array ? stringKeys.length - 1 : stringKeys.length;
  if (itemCount > MAXIMUM_METADATA_CONTAINER_ITEMS) {
    invalidMetadata("Document metadata container exceeds the item budget.");
  }
  return stringKeys;
}

function projectValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: ProjectionBudget
): DocumentMetadataValue {
  countValue(budget);
  const scalar = projectScalar(value);
  if (scalar !== NOT_SCALAR) {
    return scalar;
  }
  const container = value as object;
  if (depth > MAXIMUM_METADATA_DEPTH) {
    invalidMetadata("Document metadata exceeds the nesting budget.");
  }
  if (seen.has(container)) {
    invalidMetadata("Document metadata must be an unshared acyclic JSON tree.");
  }
  seen.add(container);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      invalidMetadata("Document metadata arrays must use the intrinsic Array prototype.");
    }
    ownDataKeys(value, true);
    const projected: DocumentMetadataValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalidMetadata("Document metadata arrays must contain enumerable own data items.");
      }
      projected.push(projectValue(descriptor.value, depth + 1, seen, budget));
    }
    return Object.freeze(projected);
  }

  const prototype = Object.getPrototypeOf(container) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    invalidMetadata("Document metadata mappings must use a plain or null prototype.");
  }
  const keys = ownDataKeys(container, false).toSorted(compareBinaryStrings);
  const projected: Record<string, DocumentMetadataValue> = {};
  for (const key of keys) {
    assertCanonicalString(key, "Document metadata key");
    if (RESERVED_KEYS.has(key)) {
      invalidMetadata(`Document metadata key ${key} is reserved.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      invalidMetadata("Document metadata mappings must contain enumerable own data properties.");
    }
    Object.defineProperty(projected, key, {
      configurable: false,
      enumerable: true,
      value: projectValue(descriptor.value, depth + 1, seen, budget),
      writable: false
    });
  }
  return Object.freeze(projected);
}

export function projectCatalogMetadata(value: unknown): DocumentMetadataObject {
  const projected = projectValue(value, 0, new WeakSet<object>(), { values: 0 });
  if (projected === null || typeof projected !== "object" || Array.isArray(projected)) {
    invalidMetadata("Document metadata root must be an object.");
  }
  const encoded = canonicalJson(projected);
  if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_METADATA_JSON_BYTES) {
    invalidMetadata("Document metadata exceeds the canonical JSON byte budget.");
  }
  return projected as DocumentMetadataObject;
}

export function mergeCatalogMetadata(
  inline: unknown,
  sidecar: DocumentMetadataObject
): DocumentMetadataObject {
  const projectedInline = projectCatalogMetadata(inline);
  const merged: Record<string, DocumentMetadataValue> = {};
  for (const [key, value] of Object.entries(sidecar)) {
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(projectedInline)) {
    const sidecarValue = merged[key];
    if (
      sidecarValue !== undefined &&
      canonicalJson(sidecarValue) !== canonicalJson(value)
    ) {
      invalidMetadata(`Inline and sidecar metadata conflict at root key ${key}.`);
    }
    merged[key] = value;
  }
  return projectCatalogMetadata(merged);
}

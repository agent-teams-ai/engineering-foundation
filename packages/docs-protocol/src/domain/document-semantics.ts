import type { DocumentJsonValue, DocumentMetadataValue } from "@agent-teams/engineering-foundation/document-authoring";

import type { DocsCodeAnchor } from "./model.js";
import { DocsProfileError } from "./profile-policy.js";

const PATTERN = /^[A-Za-z0-9._@*?/[\]-]+$/u;
const DOCUMENT_ID = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;
const MAX_ITEMS = 256;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {return true;}
  }
  return false;
}

function object(value: DocumentJsonValue | DocumentMetadataValue): Record<string, DocumentJsonValue | DocumentMetadataValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocsProfileError("Each code anchor must be an object.");
  }
  return value as Record<string, DocumentJsonValue | DocumentMetadataValue>;
}

export function normalizeCodeAnchors(values: readonly (DocumentJsonValue | DocumentMetadataValue)[]): readonly DocsCodeAnchor[] {
  if (values.length > MAX_ITEMS) {throw new DocsProfileError(`code_anchors exceeds ${MAX_ITEMS} items.`);}
  const anchors = values.map((value, index) => {
    const candidate = object(value);
    const keys = Object.keys(candidate).toSorted();
    if (keys.length !== 2 || keys[0] !== "enforcement" || keys[1] !== "pattern") {
      throw new DocsProfileError(`code_anchors[${index}] must contain exactly enforcement and pattern.`);
    }
    const enforcement = candidate["enforcement"];
    const pattern = candidate["pattern"];
    if (enforcement !== "advisory" && enforcement !== "required") {
      throw new DocsProfileError(`code_anchors[${index}].enforcement must be advisory or required.`);
    }
    if (typeof pattern !== "string" || pattern.length === 0 || Buffer.byteLength(pattern, "utf8") > 512 || pattern !== pattern.normalize("NFC") || hasControlCharacter(pattern) || !PATTERN.test(pattern)) {
      throw new DocsProfileError(`code_anchors[${index}].pattern is invalid.`);
    }
    const segments = pattern.split("/");
    if (
      pattern.startsWith("/") ||
      pattern.includes("\\") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      segments[0] === "docs" ||
      segments[0] === ".agents"
    ) {
      throw new DocsProfileError(`code_anchors[${index}].pattern must be a safe source-relative pattern outside docs and .agents.`);
    }
    return Object.freeze({ enforcement, pattern });
  });
  const identities = anchors.map(({ enforcement, pattern }) => `${enforcement}\0${pattern}`);
  if (new Set(identities).size !== identities.length) {throw new DocsProfileError("code_anchors must be unique.");}
  return Object.freeze(anchors);
}

export function normalizeDocumentIds(values: readonly string[], subject: string): readonly string[] {
  if (values.length > MAX_ITEMS) {throw new DocsProfileError(`${subject} exceeds ${MAX_ITEMS} items.`);}
  const normalized = values.map((value, index) => {
    if (
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > 214 ||
      value !== value.normalize("NFC") ||
      hasControlCharacter(value) ||
      !DOCUMENT_ID.test(value)
    ) {
      throw new DocsProfileError(`${subject}[${index}] is not a canonical document ID.`);
    }
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {throw new DocsProfileError(`${subject} contains duplicates.`);}
  return Object.freeze(normalized.toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
}

export function normalizeDocumentId(value: string, subject: string): string {
  return normalizeDocumentIds([value], subject)[0]!;
}

function assertMetadataScalar(value: unknown): boolean {
  if (value === null || typeof value === "boolean") {return true;}
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) {throw new DocsProfileError("Additional metadata strings must use Unicode NFC.");}
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {throw new DocsProfileError("Additional metadata numbers must be safe integers other than negative zero.");}
    return true;
  }
  if (typeof value !== "object") {throw new DocsProfileError("Additional metadata must use the closed JSON data model.");}
  return false;
}

function assertMetadataValue(value: unknown, depth: number, budget: { values: number }, seen: WeakSet<object>): void {
  budget.values += 1;
  if (budget.values > 100_000) {throw new DocsProfileError("Additional metadata exceeds the value budget.");}
  if (assertMetadataScalar(value)) {return;}
  const container = value as object;
  if (depth > 64 || seen.has(container)) {throw new DocsProfileError("Additional metadata must be an unshared tree of at most 64 levels.");}
  seen.add(container);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    const dense = keys.length === value.length + 1 && keys.every((key) => key === "length" || (typeof key === "string" && Number.isSafeInteger(Number(key)) && String(Number(key)) === key && Number(key) >= 0 && Number(key) < value.length));
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000 || !dense) {throw new DocsProfileError("Additional metadata array is sparse, extended, invalid, or exceeds 10000 items.");}
    value.forEach((entry) => { assertMetadataValue(entry, depth + 1, budget, seen); });
    return;
  }
  const prototype = Object.getPrototypeOf(container) as object | null;
  const keys = Reflect.ownKeys(container);
  if ((prototype !== Object.prototype && prototype !== null) || keys.length > 10_000 || keys.some((key) => typeof key !== "string")) {
    throw new DocsProfileError("Additional metadata mapping is invalid or exceeds 10000 properties.");
  }
  for (const key of keys as string[]) {
    if (key !== key.normalize("NFC") || RESERVED_KEYS.has(key)) {throw new DocsProfileError(`Additional metadata key ${key} is not canonical.`);}
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {throw new DocsProfileError(`Additional metadata key ${key} must be a data property.`);}
    assertMetadataValue(descriptor.value, depth + 1, budget, seen);
  }
}

export function assertDocumentMetadata(value: unknown): asserts value is Readonly<Record<string, DocumentJsonValue>> {
  assertMetadataValue(value, 0, { values: 0 }, new WeakSet<object>());
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new DocsProfileError("Additional metadata root must be an object.");}
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 1_048_576) {throw new DocsProfileError("Additional metadata exceeds the 1 MiB JSON budget.");}
}

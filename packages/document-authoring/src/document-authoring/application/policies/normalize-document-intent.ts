import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import type {
  DocumentIntent,
  DocumentJsonObject,
  DocumentJsonValue
} from "../model/document-planning.js";
import { DocumentPlanningPolicyError } from "./document-planning-policy-error.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const GOVERNED_KEYS = new Set([
  "destination",
  "id",
  "owner",
  "related",
  "slug",
  "status",
  "summary",
  "title",
  "type"
]);

function invalidJson(message: string): never {
  throw new DocumentPlanningPolicyError("invalid-intent-json", message);
}

function normalizeString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return invalidJson("Document Intent contains a lone UTF-16 surrogate.");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return invalidJson("Document Intent contains a lone UTF-16 surrogate.");
    }
  }
  return value.normalize("NFC");
}

function normalizeJsonObject(value: DocumentJsonObject): DocumentJsonObject {
  const normalized = new Map<string, DocumentJsonValue>();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeString(rawKey);
    if (FORBIDDEN_KEYS.has(key)) {
      return invalidJson(`Document Intent contains forbidden metadata key: ${key}.`);
    }
    if (normalized.has(key)) {
      return invalidJson("Document Intent metadata keys collide after NFC normalization.");
    }
    normalized.set(key, normalizeJson(rawValue));
  }
  return Object.freeze(Object.fromEntries(
    [...normalized].toSorted(([left], [right]) => compareBinaryStrings(left, right))
  ));
}

function isJsonArray(value: DocumentJsonValue): value is readonly DocumentJsonValue[] {
  return Array.isArray(value);
}

function normalizeJson(value: DocumentJsonValue): DocumentJsonValue {
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      return invalidJson("Document Intent numbers must be safe integers other than negative zero.");
    }
    return value;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (isJsonArray(value)) {
    return Object.freeze(value.map(normalizeJson));
  }

  return normalizeJsonObject(value);
}

function normalizeAdditionalMetadata(
  metadata: Readonly<Record<string, DocumentJsonValue>> | undefined
): Readonly<Record<string, DocumentJsonValue>> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const normalized = normalizeJsonObject(metadata);
  for (const key of Object.keys(normalized)) {
    if (GOVERNED_KEYS.has(key)) {
      return invalidJson(`Document Intent additional metadata replaces governed key: ${key}.`);
    }
  }
  return normalized;
}

export function normalizeDocumentIntent(input: DocumentIntent): DocumentIntent {
  const related = input.related?.map(normalizeString);
  if (related !== undefined && new Set(related).size !== related.length) {
    throw new DocumentPlanningPolicyError(
      "duplicate-related",
      "Document Intent related identifiers must remain unique after NFC normalization."
    );
  }
  const additionalMetadata = normalizeAdditionalMetadata(input.additionalMetadata);
  return Object.freeze({
    schemaVersion: 1,
    type: normalizeString(input.type),
    id: normalizeString(input.id),
    title: normalizeString(input.title),
    owner: normalizeString(input.owner),
    summary: normalizeString(input.summary),
    ...(input.slug === undefined ? {} : { slug: normalizeString(input.slug) }),
    ...(input.destination === undefined
      ? {}
      : { destination: normalizeString(input.destination) }),
    ...(related === undefined
      ? {}
      : { related: Object.freeze(related.toSorted(compareBinaryStrings)) }),
    ...(additionalMetadata === undefined ? {} : { additionalMetadata })
  });
}

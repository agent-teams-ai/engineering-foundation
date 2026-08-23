import { parseDocument } from "yaml";

class ConsumerJsonInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsumerJsonInputError";
  }
}

export function parseJsonRecord(source: string): Record<string, unknown> {
  const duplicateCheck = parseDocument(source, { uniqueKeys: true });
  if (duplicateCheck.errors.length > 0) {
    throw new ConsumerJsonInputError("Package manifest must not contain duplicate keys.");
  }
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConsumerJsonInputError("Package manifest must be one JSON object.");
  }
  return value as Record<string, unknown>;
}

export function recordField(
  manifest: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const value = manifest[field];
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : {};
}

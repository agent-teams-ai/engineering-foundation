import { parseStrictJson, StrictJsonError } from "@agent-teams/repository-mutation/serialization";

class ConsumerJsonInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsumerJsonInputError";
  }
}

export function parseJsonRecord(source: string, subject = "Package manifest"): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseStrictJson(source);
  } catch (error) {
    if (!(error instanceof StrictJsonError)) { throw error; }
    throw new ConsumerJsonInputError(error.failure === "duplicate-key"
      ? `${subject} must not contain duplicate keys.`
      : `${subject} must contain valid JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConsumerJsonInputError(`${subject} must be one JSON object.`);
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

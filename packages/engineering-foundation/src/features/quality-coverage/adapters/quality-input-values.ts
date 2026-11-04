import { CapabilityInputError } from "../api.js";

export function invalidQualityInput(message: string): never {
  throw new CapabilityInputError({
    code: "QUALITY_PROFILE_INVALID",
    message,
    phase: "quality-profile",
    retryable: false,
  });
}

export function qualityRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidQualityInput("Expected a data object in the quality profile inputs.");
  }
  return Object.fromEntries(Object.entries(value));
}

export function qualityString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    invalidQualityInput("Expected a bounded nonempty string in the quality profile inputs.");
  }
  return value;
}

/** Package scripts are command bodies, not short profile/path scalars. */
export function qualityScriptCommand(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16 * 1024 ||
    new TextEncoder().encode(value).byteLength > 16 * 1024
  ) {
    invalidQualityInput("Expected a nonempty package script command of at most 16384 UTF-8 bytes.");
  }
  return value;
}

export function qualityStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    invalidQualityInput("Expected a bounded list in the quality profile inputs.");
  }
  return value.map(qualityString);
}

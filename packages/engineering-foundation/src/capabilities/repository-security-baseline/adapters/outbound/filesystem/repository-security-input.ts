import { CapabilityInputError } from "../../../../../capability-runtime.js";

export function repositorySecurityInputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "repository-security-evidence",
    retryable: false
  });
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_EVIDENCE_INVALID",
      `${field} must be an object.`
    );
  }
  return value as Record<string, unknown>;
}

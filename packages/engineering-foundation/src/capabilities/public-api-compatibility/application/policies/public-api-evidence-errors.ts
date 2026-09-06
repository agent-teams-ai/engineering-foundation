import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import { ContainedFileReadError } from "../../../../source-inventory/api.js";

export { assertNotCancelled } from "../../../../features/validation-reporting/api.js";

export function publicApiInputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

export function isPublicApiInputError(error: unknown): boolean {
  return error instanceof CapabilityInputError;
}

export function publicApiFileFailure(error: unknown): ContainedFileReadError["failure"] | undefined {
  return error instanceof ContainedFileReadError ? error.failure : undefined;
}

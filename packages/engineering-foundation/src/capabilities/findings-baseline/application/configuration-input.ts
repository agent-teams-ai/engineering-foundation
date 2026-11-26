import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { assertRepositoryRelativePath } from "../../../source-inventory/api.js";

/** Input failures of the configuration and the baseline file; adapters report them through this one gate. */
export function inputFailure(
  code: string,
  message: string,
  phase: string,
  options?: ErrorOptions,
): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false }, options);
}

export function assertConfigRepositoryRelativePath(path: string, phase: string): void {
  assertRepositoryRelativePath(path, phase);
}

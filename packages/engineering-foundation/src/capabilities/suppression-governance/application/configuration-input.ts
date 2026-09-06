import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { assertRepositoryRelativePath } from "../../../source-inventory/api.js";

export function configurationInputError(message: string): never {
  throw new CapabilityInputError({
    code: "SUPPRESSION_GOVERNANCE_CONFIG_INVALID",
    message,
    phase: "suppression-governance-config",
    retryable: false
  });
}


export function assertConfigRepositoryRelativePath(path: string): void {
  assertRepositoryRelativePath(path, "suppression-governance-config");
}

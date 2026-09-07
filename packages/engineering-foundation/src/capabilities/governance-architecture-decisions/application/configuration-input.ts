import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { assertRepositoryRelativePath } from "../../../source-inventory/api.js";

export function configurationInputError(message: string): never {
  throw new CapabilityInputError({
    code: "ARCHITECTURE_DECISION_GOVERNANCE_CONFIG_INVALID",
    message,
    phase: "architecture-decision-governance-config",
    retryable: false
  });
}


export function assertConfigurationRepositoryPath(path: string): void {
  assertRepositoryRelativePath(path, "architecture-decision-governance-config");
}

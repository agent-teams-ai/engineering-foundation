import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
export { assertNotCancelled as assertConfigurationNotCancelled } from "../../../features/validation-reporting/api.js";

export function configurationInputError(message: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_ARCHITECTURE_CONFIG_INVALID",
    message,
    phase: "source-architecture-config",
    retryable: false
  });
}


export function ambiguousConfigurationBoundary(message: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_BOUNDARY_AMBIGUOUS",
    message,
    phase: "source-boundary-classification",
    retryable: false
  });
}

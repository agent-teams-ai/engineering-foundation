import { CapabilityInputError } from "../../../features/validation-reporting/api.js";

export function configurationSchemaError(message: string): never {
  throw new CapabilityInputError({
    code: "SCHEMA_INVALID",
    message,
    phase: "workspace-dependency-declarations-config",
    retryable: false
  });
}

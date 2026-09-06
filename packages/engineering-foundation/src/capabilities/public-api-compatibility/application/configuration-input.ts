import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { assertRepositoryRelativePath } from "../../../source-inventory/api.js";

export function configurationInputError(message: string): never {
  throw new CapabilityInputError({
    code: "PUBLIC_API_COMPATIBILITY_CONFIG_INVALID",
    message,
    phase: "public-api-compatibility-config",
    retryable: false
  });
}

export function assertConfigurationRepositoryPath(path: string): void {
  assertRepositoryRelativePath(path, "public-api-compatibility-config");
}

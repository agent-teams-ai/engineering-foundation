import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { assertRepositoryRelativePath } from "../../../source-inventory/api.js";

export function configurationInputError(message: string): never {
  throw new CapabilityInputError({
    code: "DOCUMENTATION_LOCAL_REFERENCES_CONFIG_INVALID",
    message,
    phase: "documentation-local-references-config",
    retryable: false
  });
}


export function assertConfigRepositoryRelativePath(path: string): void {
  assertRepositoryRelativePath(path, "documentation-local-references-config");
}

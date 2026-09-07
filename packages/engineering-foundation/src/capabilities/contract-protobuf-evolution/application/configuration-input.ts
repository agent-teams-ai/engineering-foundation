import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { assertRepositoryRelativePath } from "../../../source-inventory/api.js";
export { assertNotCancelled as assertConfigurationNotCancelled } from "../../../features/validation-reporting/api.js";

export function configurationInputError(message: string): never {
  throw new CapabilityInputError({
    code: "PROTOBUF_EVOLUTION_CONFIG_INVALID",
    message,
    phase: "protobuf-evolution-config",
    retryable: false
  });
}
export function assertConfigurationRepositoryPath(path: string): void {
  assertRepositoryRelativePath(path, "protobuf-evolution-config");
}

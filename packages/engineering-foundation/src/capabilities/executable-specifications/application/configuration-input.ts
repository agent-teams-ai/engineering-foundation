import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { ContainedFileReadError, assertRepositoryRelativePath } from "../../../source-inventory/api.js";
export { assertNotCancelled as assertConfigurationNotCancelled } from "../../../features/validation-reporting/api.js";

export function configurationInputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "executable-specification-config",
    retryable: false
  });
}


export function assertConfigurationRepositoryPath(path: string): void {
  assertRepositoryRelativePath(path, "executable-specification-config");
}

export function catalogReadFailure(error: unknown, catalogPath: string): never {
  if (error instanceof ContainedFileReadError) {
    configurationInputError(
      `EXECUTABLE_SPECIFICATION_CATALOG_${error.failure.toUpperCase()}`,
      `Executable specification catalog is not a contained regular file: ${catalogPath}.`
    );
  }
  throw error;
}

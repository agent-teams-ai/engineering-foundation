import { CapabilityInputError, assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import { ContainedFileReadError, assertRepositoryRelativePath } from "../../../../source-inventory/api.js";

export function jsonSchemaInputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "json-schema-release-inspection",
    retryable: false
  });
}

export function assertJsonSchemaInspectionActive(signal: AbortSignal | undefined): void {
  assertNotCancelled(signal);
}

export function assertJsonSchemaRepositoryPath(repositoryPath: string): void {
  assertRepositoryRelativePath(repositoryPath, "json-schema-release-inspection");
}

export function assertJsonSchemaEvidencePath(repositoryPath: string): void {
  assertJsonSchemaRepositoryPath(repositoryPath);
  if (!repositoryPath.endsWith(".json")) {
    jsonSchemaInputError("JSON_SCHEMA_PATH_INVALID", `JSON evidence path must end with .json: ${repositoryPath}.`);
  }
}

export function rejectJsonSchemaFileFailure(error: unknown, repositoryPath: string): never {
  if (!(error instanceof ContainedFileReadError)) {throw error;}
  if (error.failure === "escape") {
    jsonSchemaInputError("JSON_SCHEMA_PATH_ESCAPE", `JSON evidence escapes the consumer root: ${repositoryPath}.`);
  }
  if (error.failure === "symlink") {
    jsonSchemaInputError("JSON_SCHEMA_SYMLINK_PROHIBITED", `JSON evidence cannot traverse a symbolic link: ${repositoryPath}.`);
  }
  if (error.failure === "invalid") {
    jsonSchemaInputError("JSON_SCHEMA_FILE_INVALID", `JSON evidence is not a supported file: ${repositoryPath}.`);
  }
  jsonSchemaInputError("JSON_SCHEMA_FILE_UNAVAILABLE", `JSON evidence is unavailable: ${repositoryPath}.`);
}

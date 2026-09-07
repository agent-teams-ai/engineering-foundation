import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import { ContainedFileReadError } from "../../../../source-inventory/api.js";

export { assertNotCancelled as assertSourceTopologyActive } from "../../../../features/validation-reporting/api.js";

export function sourceTopologyInputError(code: string, message: string): never {
  throw new CapabilityInputError({ code, message, phase: "source-workspace-topology", retryable: false });
}

export function isSourceTopologyProblem(error: unknown, code: string): boolean {
  return error instanceof CapabilityInputError && error.problem.code === code;
}

export function rejectSourceFileRead(error: unknown, path: string): never {
  if (!(error instanceof ContainedFileReadError)) {throw error;}
  if (error.failure === "escape") {
    sourceTopologyInputError("SOURCE_DIRECTORY_ESCAPE", `Source file escapes the consumer repository: ${path}.`);
  }
  if (error.failure === "symlink") {
    sourceTopologyInputError("SOURCE_SYMLINK_PROHIBITED", `Selected workspace source cannot contain symbolic links: ${path}.`);
  }
  if (error.failure === "changed") {
    sourceTopologyInputError("SOURCE_FILESYSTEM_CHANGED", `Source file changed while it was read: ${path}.`);
  }
  if (error.failure === "invalid") {
    sourceTopologyInputError("SOURCE_FILE_INVALID", `Source file is not a regular file within the supported size limit: ${path}.`);
  }
  sourceTopologyInputError("SOURCE_FILE_UNAVAILABLE", `Source file is unavailable: ${path}.`);
}

export function assertSourceFileByteLimit(byteLength: number, maxBytes: number, path: string): void {
  if (byteLength > maxBytes) {
    sourceTopologyInputError("SOURCE_FILE_INVALID", `Source file is not a regular file within the supported size limit: ${path}.`);
  }
}

export function assertSourceManifestByteLimit(byteLength: number, maxBytes: number, path: string): void {
  if (byteLength > maxBytes) {
    sourceTopologyInputError("PACKAGE_MANIFEST_INVALID", `Nested package scope is unavailable or invalid: ${path}.`);
  }
}

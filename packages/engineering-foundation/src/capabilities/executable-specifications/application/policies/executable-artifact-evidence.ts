import { CapabilityInputError, assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import { ContainedFileReadError } from "../../../../source-inventory/api.js";

export function executableInspectionInputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "executable-specification-inspection",
    retryable: false
  });
}

export function assertExecutableInspectionActive(signal: AbortSignal | undefined): void {
  assertNotCancelled(signal);
}

export function executableArtifactReadFailure(error: unknown, repositoryPath: string): undefined {
  if (!(error instanceof ContainedFileReadError)) {throw error;}
  if (error.failure === "missing") {return undefined;}
  executableInspectionInputError(
    `EXECUTABLE_SPECIFICATION_ARTIFACT_${error.failure.toUpperCase()}`,
    `Specification artifact is not a safe contained regular file: ${repositoryPath}.`
  );
}

export function assertExecutableArtifactSize(byteLength: number, maxBytes: number, repositoryPath: string): void {
  if (byteLength > maxBytes) {
    executableInspectionInputError(
      "EXECUTABLE_SPECIFICATION_ARTIFACT_INVALID",
      `Specification artifact is not a safe contained regular file: ${repositoryPath}.`
    );
  }
}

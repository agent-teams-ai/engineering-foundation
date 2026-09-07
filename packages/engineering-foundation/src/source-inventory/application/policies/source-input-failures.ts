import { CapabilityInputError, assertNotCancelled } from "../../../features/validation-reporting/api.js";

export function assertSourceReadActive(signal?: AbortSignal): void {
  assertNotCancelled(signal);
}

export function sourceRootSymlink(repositoryPath: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_SYMLINK_PROHIBITED",
    message: `Governed source roots cannot be symbolic links: ${repositoryPath}.`,
    phase: "source-discovery",
    retryable: false
  });
}

export function sourceRootUnavailable(repositoryPath: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_DIRECTORY_UNAVAILABLE",
    message: `Required source directory is unavailable: ${repositoryPath}.`,
    phase: "source-discovery",
    retryable: false
  });
}

export function sourceRootEscape(repositoryPath: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_DIRECTORY_ESCAPE",
    message: `Source directory escapes the consumer repository: ${repositoryPath}.`,
    phase: "source-discovery",
    retryable: false
  });
}

export function sourceRootNotDirectory(repositoryPath: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_DIRECTORY_INVALID",
    message: `Source path must be a directory: ${repositoryPath}.`,
    phase: "source-discovery",
    retryable: false
  });
}

export function sourcePathCollision(existing: string, path: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_PATH_CASE_COLLISION",
    message: `Source paths differ only by letter case: ${existing} and ${path}.`,
    phase: "source-discovery",
    retryable: false
  });
}

export function sourceEntrySymlink(entryPath: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_SYMLINK_PROHIBITED",
    message: `Source trees cannot contain symbolic links: ${entryPath}.`,
    phase: "source-discovery",
    retryable: false
  });
}

export function sourceFileCountExceeded(maximum: number): never {
  throw new CapabilityInputError({
    code: "SOURCE_FILE_LIMIT_EXCEEDED",
    message: `Governed source contains more than ${maximum} files.`,
    phase: "source-discovery",
    retryable: false
  });
}

export function unstableSourceFile(path: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_FILE_INVALID",
    message: `Source changed, escaped containment, or is not one stable regular file: ${path}.`,
    phase: "source-read",
    retryable: false
  });
}

export function nulSourceFile(path: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_FILE_INVALID",
    message: `Source file contains prohibited NUL bytes: ${path}.`,
    phase: "source-read",
    retryable: false
  });
}

export function sourceByteBudgetExceeded(maximum: number): never {
  throw new CapabilityInputError({
    code: "SOURCE_SIZE_LIMIT_EXCEEDED",
    message: `Governed source exceeds ${maximum} bytes.`,
    phase: "source-read",
    retryable: false
  });
}

export function sourceConsumerUnavailable(): never {
  throw new CapabilityInputError({
    code: "CONSUMER_ROOT_UNAVAILABLE",
    message: "Consumer root must be an existing accessible directory.",
    phase: "source-workspace",
    retryable: false
  });
}

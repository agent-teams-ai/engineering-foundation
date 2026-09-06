import { CapabilityInputError, assertNotCancelled } from "../../validation-reporting/api.js";
import type { FoundationProblem } from "../../validation-reporting/api.js";
import type { ContainedFileReadFailure } from "../../../source-inventory/api.js";

export const MAX_CONFIG_BYTES = 1024 * 1024;

function configurationFileProblem(
  failure: ContainedFileReadFailure,
  repositoryPath: string,
  phase: string
): FoundationProblem {
  const problem = failure === "escape"
    ? {
        code: "CONFIG_PATH_ESCAPE",
        message: `Configuration path escapes the consumer repository: ${repositoryPath}.`
      }
    : failure === "invalid"
      ? {
          code: "CONFIG_FILE_INVALID",
          message: `Configuration file must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes: ${repositoryPath}.`
        }
      : failure === "symlink"
        ? {
            code: "CONFIG_SYMLINK_PROHIBITED",
            message: `Configuration path cannot be a symbolic link: ${repositoryPath}.`
          }
        : {
            code: "CONFIG_FILE_UNAVAILABLE",
            message: `Required configuration file is unavailable or changed while reading: ${repositoryPath}.`
          };
  return { ...problem, phase, retryable: false };
}

export function assertConfigurationReadActive(signal?: AbortSignal): void {
  assertNotCancelled(signal);
}

export function rejectConfigurationRoot(error: unknown, phase: string): never {
  if (error instanceof CapabilityInputError) { throw error; }
  throw new CapabilityInputError({ code: "CONSUMER_ROOT_UNAVAILABLE", message: "Consumer root must be an existing accessible directory.", phase, retryable: false });
}

export function rejectNonDirectoryConfigurationRoot(phase: string): never {
  throw new CapabilityInputError({ code: "CONSUMER_ROOT_INVALID", message: "Consumer root must be an existing directory.", phase, retryable: false });
}

export function rejectConfigurationFile(failure: ContainedFileReadFailure, path: string, phase: string): never {
  throw new CapabilityInputError(configurationFileProblem(failure, path, phase));
}

export function rejectYamlInput(message: string, phase: string): never {
  throw new CapabilityInputError({ code: "YAML_INVALID", message: message || "YAML input is invalid.", phase, retryable: false });
}

export function rejectYamlFeature(message: string, phase: string): never {
  throw new CapabilityInputError({ code: "YAML_FEATURE_PROHIBITED", message, phase, retryable: false });
}

export function rejectSchemaInput(message: string, phase: string): never {
  throw new CapabilityInputError({ code: "SCHEMA_INVALID", message, phase, retryable: false });
}

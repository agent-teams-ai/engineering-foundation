import type { FoundationProblem } from "../../validation-reporting/api.js";
import type { ContainedFileReadFailure } from "../../../source-inventory/api.js";

export const MAX_CONFIG_BYTES = 1024 * 1024;

export function configurationFileProblem(
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

import { ContainedFileReadError } from "../../../../source-inventory/api.js";
import { repositorySecurityInputError } from "./repository-security-input.js";

function mapFileReadFailure(error: ContainedFileReadError, repositoryPath: string): never {
  if (error.failure === "escape") {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_EVIDENCE_ESCAPE",
      `Security evidence escapes the repository: ${repositoryPath}.`
    );
  }
  if (error.failure === "symlink") {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_SYMLINK_PROHIBITED",
      `Security evidence cannot traverse a symbolic link: ${repositoryPath}.`
    );
  }
  if (error.failure === "invalid") {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_EVIDENCE_INVALID",
      `Security evidence is not a valid file: ${repositoryPath}.`
    );
  }
  repositorySecurityInputError(
    "REPOSITORY_SECURITY_EVIDENCE_UNAVAILABLE",
    `Security evidence is unavailable or changed while reading: ${repositoryPath}.`
  );
}

export function rejectSecurityFileReadFailure(error: unknown, repositoryPath: string, optional: false): never;
export function rejectSecurityFileReadFailure(error: unknown, repositoryPath: string, optional: true): undefined;
export function rejectSecurityFileReadFailure(
  error: unknown,
  repositoryPath: string,
  optional: boolean
): undefined {
  if (error instanceof ContainedFileReadError) {
    if (optional && error.failure === "missing") {
      return undefined;
    }
    mapFileReadFailure(error, repositoryPath);
  }
  throw error;
}

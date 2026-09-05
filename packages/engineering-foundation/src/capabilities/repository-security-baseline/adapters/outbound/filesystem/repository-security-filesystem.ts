import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ContainedFileReadError } from "../../../../../source-inventory/api.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "../../../../../source-inventory/node.js";
import { repositorySecurityInputError } from "./repository-security-input.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function isContained(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

export async function resolveConsumerRoot(consumerRoot: string): Promise<string> {
  return realpath(consumerRoot).catch(() =>
    repositorySecurityInputError(
      "CONSUMER_ROOT_UNAVAILABLE",
      "Consumer root must be an accessible directory."
    )
  );
}

export async function resolveSafeEvidencePath(
  root: string,
  repositoryPath: string
): Promise<string> {
  const candidate = resolve(root, repositoryPath);
  if (await pathTraversesSymbolicLink(root, candidate)) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_SYMLINK_PROHIBITED",
      `Security evidence cannot traverse a symbolic link: ${repositoryPath}.`
    );
  }
  const canonical = await realpath(candidate).catch(() =>
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_EVIDENCE_UNAVAILABLE",
      `Security evidence is unavailable: ${repositoryPath}.`
    )
  );
  if (!isContained(root, canonical)) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_EVIDENCE_ESCAPE",
      `Security evidence escapes the repository: ${repositoryPath}.`
    );
  }
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_EVIDENCE_INVALID",
      `Security evidence is not a valid directory: ${repositoryPath}.`
    );
  }
  return canonical;
}

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

export async function readRequiredEvidenceFile(
  root: string,
  repositoryPath: string
): Promise<Buffer> {
  try {
    return await readContainedRegularFile({
      candidate: resolve(root, repositoryPath),
      maxBytes: MAX_FILE_BYTES,
      root
    });
  } catch (error) {
    if (error instanceof ContainedFileReadError) {
      mapFileReadFailure(error, repositoryPath);
    }
    throw error;
  }
}

export async function readOptionalEvidenceFile(
  root: string,
  repositoryPath: string
): Promise<Buffer | undefined> {
  try {
    return await readContainedRegularFile({
      candidate: resolve(root, repositoryPath),
      maxBytes: MAX_FILE_BYTES,
      root
    });
  } catch (error) {
    if (error instanceof ContainedFileReadError) {
      if (error.failure === "missing") {
        return undefined;
      }
      mapFileReadFailure(error, repositoryPath);
    }
    throw error;
  }
}

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { SecurityEvidenceObservation } from "../../../application/ports/security-evidence-observation.js";
import { rejectSecurityFileReadFailure } from "../../../application/policies/security-file-read-failure.js";
import { repositorySecurityInputError } from "../../../application/policies/repository-security-input.js";

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
  observation: SecurityEvidenceObservation,
  root: string,
  repositoryPath: string
): Promise<string> {
  const candidate = resolve(root, repositoryPath);
  if (await observation.traversesSymbolicLink(root, candidate)) {
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

export async function readRequiredEvidenceFile(
  observation: SecurityEvidenceObservation,
  root: string,
  repositoryPath: string
): Promise<Buffer> {
  try {
    const source = await observation.read({
      candidate: resolve(root, repositoryPath),
      maxBytes: MAX_FILE_BYTES,
      root
    });
    return Buffer.isBuffer(source) ? source : Buffer.from(source);
  } catch (error) {
    rejectSecurityFileReadFailure(error, repositoryPath, false);
  }
}

export async function readOptionalEvidenceFile(
  observation: SecurityEvidenceObservation,
  root: string,
  repositoryPath: string
): Promise<Buffer | undefined> {
  try {
    const source = await observation.read({
      candidate: resolve(root, repositoryPath),
      maxBytes: MAX_FILE_BYTES,
      root
    });
    return Buffer.isBuffer(source) ? source : Buffer.from(source);
  } catch (error) {
    rejectSecurityFileReadFailure(error, repositoryPath, true);
    return undefined;
  }
}

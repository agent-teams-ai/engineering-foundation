import { isDocumentRepositoryPath } from "./document-repository-path.js";

const CANONICAL_SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TEMPORARY_PREFIX = ".foundation-document-";
const TEMPORARY_SUFFIX = ".tmp";

class DocumentTemporaryPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DocumentTemporaryPathError";
  }
}

/**
 * Derives the only transaction-owned temporary path for a Document Plan.
 * The name is bounded independently of the destination basename and remains
 * in the destination's already-authorized parent directory.
 */
export function documentTemporaryPath(
  destination: string,
  planDigest: string
): string {
  if (!isDocumentRepositoryPath(destination)) {
    throw new DocumentTemporaryPathError(
      "Document destination is not a portable repository path."
    );
  }
  if (!CANONICAL_SHA256_DIGEST.test(planDigest)) {
    throw new DocumentTemporaryPathError(
      "Document Plan digest is not canonical SHA-256."
    );
  }

  const separator = destination.lastIndexOf("/");
  const parent = separator === -1 ? "" : destination.slice(0, separator);
  const temporaryName = `${TEMPORARY_PREFIX}${planDigest.slice("sha256:".length)}${TEMPORARY_SUFFIX}`;
  const temporaryPath = parent.length === 0
    ? temporaryName
    : `${parent}/${temporaryName}`;

  if (!isDocumentRepositoryPath(temporaryPath)) {
    throw new DocumentTemporaryPathError(
      "Document destination parent cannot contain the bounded transaction temporary."
    );
  }
  return temporaryPath;
}

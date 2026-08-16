import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type {
  KnownFileImageV1,
  KnownFileTransactionPlanV1
} from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalOperationV1 } from "../../application/model/known-file-transaction-journal.js";
import {
  portableRepositoryPathIdentity,
  portableRepositoryPathProblem
} from "../../application/model/repository-path.js";
import {
  captureFileHandleIdentity,
  readBoundedRegularFile
} from "./node-bounded-regular-file.js";
import { isLexicallyContainedPath } from "./node-repository-path.js";

const MAXIMUM_MANAGED_FILE_BYTES = 8 * 1024 * 1024;

export class KnownFileTransactionError extends Error {
  readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KnownFileTransactionError";
    this.code = code;
  }
}

export interface ObservedKnownFile {
  readonly state: "absent" | "file";
  readonly bytes?: Buffer;
  readonly identity?: Awaited<ReturnType<typeof captureFileHandleIdentity>>;
  readonly mode?: number;
}

export function knownFileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export function sameKnownFileIdentity(
  left: Awaited<ReturnType<typeof captureFileHandleIdentity>>,
  right: Awaited<ReturnType<typeof captureFileHandleIdentity>>
): boolean {
  return left.birthtimeNs === right.birthtimeNs &&
    left.dev === right.dev && left.ino === right.ino;
}

export function knownFileImageBytes(image: KnownFileImageV1): Buffer {
  return Buffer.from(image.contentBase64, "base64");
}

export function matchesKnownFileImage(
  observed: ObservedKnownFile,
  image: KnownFileImageV1
): boolean {
  return observed.state === "file" && observed.bytes !== undefined &&
    observed.bytes.byteLength === image.size &&
    `sha256:${createHash("sha256").update(observed.bytes).digest("hex")}` === image.digest &&
    observed.mode === image.mode;
}

export function knownFileTemporaryName(
  path: string,
  planDigest: string,
  operationIndex: number
): string {
  return `.${basename(path)}.agent-teams.${planDigest.slice(7, 23)}.${operationIndex}.tmp`;
}

export async function canonicalKnownFileRoot(consumerRoot: string): Promise<string> {
  const requested = resolve(consumerRoot);
  const metadata = await lstat(requested);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_ROOT_INVALID",
      "Consumer root must be one real directory, not a symlink."
    );
  }
  return realpath(requested);
}

export async function knownFileAliasEntry(
  parent: string,
  requested: string
): Promise<string | undefined> {
  const identity = portableRepositoryPathIdentity(requested);
  const matches = (await readdir(parent)).filter(
    (entry) => portableRepositoryPathIdentity(entry) === identity
  );
  if (matches.some((entry) => entry !== requested)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_PATH_ALIAS",
      `Portable case or Unicode path collision blocks ${requested}.`
    );
  }
  return matches.find((entry) => entry === requested);
}

async function resolveExistingParent(
  root: string,
  repositoryPath: string
): Promise<{ readonly absolute: string; readonly complete: boolean }> {
  const problem = portableRepositoryPathProblem(repositoryPath);
  if (problem !== undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_PATH_INVALID",
      `Repository path is not portable (${problem}): ${repositoryPath}.`
    );
  }
  const segments = repositoryPath.split("/");
  segments.pop();
  let current = root;
  for (const segment of segments) {
    if (await knownFileAliasEntry(current, segment) === undefined) {
      return { absolute: current, complete: false };
    }
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_ANCESTOR_INVALID",
        `Repository ancestor must be one real directory: ${repositoryPath}.`
      );
    }
    const canonical = await realpath(current);
    if (!isLexicallyContainedPath(root, canonical) || canonical !== current) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_PATH_ESCAPE",
        `Repository ancestor escapes or aliases the root: ${repositoryPath}.`
      );
    }
  }
  return { absolute: current, complete: true };
}

export async function observeKnownFile(
  root: string,
  repositoryPath: string,
  maximumBytes: number
): Promise<ObservedKnownFile> {
  const parent = await resolveExistingParent(root, repositoryPath);
  if (!parent.complete) {return { state: "absent" };}
  const name = repositoryPath.split("/").at(-1)!;
  if (await knownFileAliasEntry(parent.absolute, name) === undefined) {
    return { state: "absent" };
  }
  const path = join(root, ...repositoryPath.split("/"));
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_DESTINATION_INVALID",
      `Managed path must be a real regular file: ${repositoryPath}.`
    );
  }
  if (metadata.nlink > 1n) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_HARDLINK",
      `Managed path has multiple hard links: ${repositoryPath}.`
    );
  }
  const observed = await readBoundedRegularFile(
    path,
    Math.max(maximumBytes, MAXIMUM_MANAGED_FILE_BYTES)
  );
  if (observed.outcome !== "read") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_UNSTABLE",
      `Managed path is oversized, unstable, or invalid: ${repositoryPath}.`
    );
  }
  return {
    state: "file",
    bytes: observed.bytes,
    identity: observed.identity,
    mode: observed.mode & 0o777
  };
}

export function maximumKnownFileEvidenceBytes(
  operation: KnownFileTransactionPlanV1["operations"][number]
): number {
  return Math.max(
    operation.postimage.size,
    ...(operation.precondition.state === "known-file"
      ? operation.precondition.acceptedPreimages.map(({ size }) => size)
      : [0])
  );
}

export function classifyKnownFileOperation(
  operation: KnownFileTransactionPlanV1["operations"][number],
  observed: ObservedKnownFile
): KnownFileTransactionJournalOperationV1 {
  if (matchesKnownFileImage(observed, operation.postimage)) {
    return { path: operation.path, state: "already-satisfied" };
  }
  if (operation.precondition.state === "absent") {
    if (observed.state !== "absent") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_CAS_MISMATCH",
        `Expected an absent managed path: ${operation.path}.`
      );
    }
    return { path: operation.path, state: "pending" };
  }
  const matchedPreimage = operation.precondition.acceptedPreimages.findIndex(
    (image) => matchesKnownFileImage(observed, image)
  );
  if (matchedPreimage === -1) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `Managed path does not match an exact accepted preimage: ${operation.path}.`
    );
  }
  return { path: operation.path, state: "pending", matchedPreimage };
}

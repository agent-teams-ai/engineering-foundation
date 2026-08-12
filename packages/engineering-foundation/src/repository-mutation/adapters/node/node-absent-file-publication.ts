import { createHash } from "node:crypto";
import { link, lstat, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  AbsentFilePublicationError,
  type AbsentFilePublicationOutcome,
  type ExactFilePostimage,
  type ExactFilePostimageState
} from "../../application/model/exact-postimage.js";
import { portableRepositoryPathIdentity } from "../../application/model/repository-path.js";
import {
  captureFileHandleIdentity,
  pathMatchesRegularFileIdentity,
  readBoundedRegularFile
} from "./node-bounded-regular-file.js";
import { syncDirectoryDurably } from "./node-directory-durability.js";

export interface AbsentFilePublicationFaultPoint {
  readonly phase:
    | "after-hard-link"
    | "after-temporary-synced"
    | "after-temporary-written";
}

export type AbsentFilePublicationFaultInjector = (
  point: AbsentFilePublicationFaultPoint
) => Promise<void> | void;

interface AbsentFilePublicationOperations {
  readonly link: typeof link;
  readonly open: (
    path: string,
    flags: "wx",
    mode: number
  ) => Promise<FileHandle>;
  readonly rm: (path: string) => Promise<void>;
  readonly syncDirectory: typeof syncDirectoryDurably;
}

const nodeOperations: AbsentFilePublicationOperations = {
  link,
  open,
  rm,
  syncDirectory: syncDirectoryDurably
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isUnsupportedLink(error: unknown): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(
    errorCode(error) ?? ""
  );
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertValidPostimage(postimage: ExactFilePostimage): void {
  if (
    !Number.isSafeInteger(postimage.size) ||
    postimage.size < 0 ||
    postimage.bytes.byteLength !== postimage.size ||
    sha256(postimage.bytes) !== postimage.digest ||
    !Number.isSafeInteger(postimage.mode) ||
    postimage.mode < 0 ||
    postimage.mode > 0o777
  ) {
    throw new AbsentFilePublicationError(
      "INVALID_POSTIMAGE",
      "Exact file postimage metadata does not match its bytes."
    );
  }
}

function snapshotPostimage(postimage: ExactFilePostimage): ExactFilePostimage {
  const snapshot = {
    bytes: Buffer.from(postimage.bytes),
    digest: postimage.digest,
    mode: postimage.mode,
    size: postimage.size
  };
  assertValidPostimage(snapshot);
  return snapshot;
}

function assertValidPublicationPaths(
  temporaryPath: string,
  destinationPath: string,
  displayPath: string
): void {
  const resolvedTemporary = resolve(temporaryPath);
  const resolvedDestination = resolve(destinationPath);
  if (
    portableRepositoryPathIdentity(resolvedTemporary) ===
      portableRepositoryPathIdentity(resolvedDestination) ||
    dirname(resolvedTemporary) !== dirname(resolvedDestination)
  ) {
    throw new AbsentFilePublicationError(
      "PUBLICATION_INVALID",
      `Publication paths are not distinct siblings: ${displayPath}.`
    );
  }
}

export async function classifyExactFilePostimage(
  destinationPath: string,
  postimage: ExactFilePostimage
): Promise<ExactFilePostimageState> {
  const snapshot = snapshotPostimage(postimage);
  try {
    const result = await readBoundedRegularFile(destinationPath, snapshot.size);
    if (result.outcome !== "read") {
      return "conflict";
    }
    const modeMatches =
      process.platform === "win32" ||
      (result.mode & 0o777) === snapshot.mode;
    return result.bytes.byteLength === snapshot.size &&
      sha256(result.bytes) === snapshot.digest &&
      modeMatches
      ? "exact"
      : "conflict";
  } catch (error) {
    if (isMissing(error)) {
      return "absent";
    }
    throw error;
  }
}

export async function assertTemporaryPathsAbsent(
  entries: readonly { readonly displayPath: string; readonly temporaryPath: string }[]
): Promise<void> {
  for (const entry of entries) {
    try {
      await lstat(entry.temporaryPath);
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw error;
    }
    throw new AbsentFilePublicationError(
      "TEMPORARY_EXISTS",
      `Temporary path already exists: ${entry.displayPath}.`
    );
  }
}

export async function publishAbsentFile(options: {
  readonly allowUnsupportedDirectoryDurability?: boolean;
  readonly destinationPath: string;
  readonly displayPath: string;
  readonly faultInjector?: AbsentFilePublicationFaultInjector;
  readonly operations?: Partial<AbsentFilePublicationOperations>;
  readonly postimage: ExactFilePostimage;
  readonly temporaryPath: string;
}): Promise<AbsentFilePublicationOutcome> {
  const destinationPath = options.destinationPath;
  const displayPath = options.displayPath;
  const temporaryPath = options.temporaryPath;
  const postimage = snapshotPostimage(options.postimage);
  assertValidPublicationPaths(temporaryPath, destinationPath, displayPath);
  const operations = { ...nodeOperations, ...options.operations };
  const initial = await classifyExactFilePostimage(
    destinationPath,
    postimage
  );
  if (initial === "exact") {
    return "already-satisfied";
  }
  if (initial === "conflict") {
    throw new AbsentFilePublicationError(
      "CONFLICT",
      `Destination changed concurrently: ${displayPath}.`
    );
  }

  const parent = dirname(resolve(destinationPath));
  let temporaryIdentity;
  let concurrentSatisfied = false;
  let published = false;
  let publicationError: unknown;
  try {
    const handle = await operations.open(temporaryPath, "wx", 0o600).catch(
      (error: unknown) => {
        if (errorCode(error) === "EEXIST") {
          throw new AbsentFilePublicationError(
            "TEMPORARY_EXISTS",
            `Temporary path already exists: ${displayPath}.`,
            { cause: error }
          );
        }
        throw error;
      }
    );
    try {
      temporaryIdentity = await captureFileHandleIdentity(handle);
      await handle.writeFile(postimage.bytes);
      await options.faultInjector?.({ phase: "after-temporary-written" });
      await handle.chmod(postimage.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.faultInjector?.({ phase: "after-temporary-synced" });
    try {
      await operations.link(temporaryPath, destinationPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        if (
          (await classifyExactFilePostimage(
            destinationPath,
            postimage
          )) === "exact"
        ) {
          concurrentSatisfied = true;
        } else {
          throw new AbsentFilePublicationError(
            "CONFLICT",
            `Destination changed concurrently: ${displayPath}.`,
            { cause: error }
          );
        }
      } else if (isUnsupportedLink(error)) {
        throw new AbsentFilePublicationError(
          "PUBLICATION_UNSUPPORTED",
          `Atomic absent-only publication is unsupported: ${displayPath}.`,
          { cause: error }
        );
      } else {
        throw error;
      }
    }
    if (!concurrentSatisfied) {
      published = true;
      await options.faultInjector?.({ phase: "after-hard-link" });
      const durability = await operations.syncDirectory(parent);
      if (
        durability === "unsupported" &&
        options.allowUnsupportedDirectoryDurability !== true
      ) {
        throw new AbsentFilePublicationError(
          "PUBLICATION_UNSUPPORTED",
          `Directory durability is unsupported: ${displayPath}.`
        );
      }
    }
  } catch (error) {
    publicationError = error;
  }

  try {
    const ownership =
      temporaryIdentity === undefined
        ? "missing"
        : await pathMatchesRegularFileIdentity(temporaryPath, temporaryIdentity);
    if (ownership === "match") {
      await operations.rm(temporaryPath);
      const durability = await operations.syncDirectory(parent);
      if (
        durability === "unsupported" &&
        options.allowUnsupportedDirectoryDurability !== true
      ) {
        throw new AbsentFilePublicationError(
          "PUBLICATION_UNSUPPORTED",
          `Directory durability is unsupported: ${displayPath}.`
        );
      }
    } else if (ownership === "different") {
      throw new AbsentFilePublicationError(
        "TEMPORARY_REPLACED",
        `Temporary path was replaced concurrently: ${displayPath}.`,
        publicationError === undefined ? undefined : { cause: publicationError }
      );
    }
  } catch (cleanupError) {
    if (
      cleanupError instanceof AbsentFilePublicationError &&
      cleanupError.code === "TEMPORARY_REPLACED"
    ) {
      throw cleanupError;
    }
    throw new AbsentFilePublicationError(
      "CLEANUP_FAILED",
      `Publication temporary cleanup failed: ${displayPath}.`,
      {
        cause: publicationError ?? cleanupError,
        cleanupError
      }
    );
  }
  if (publicationError !== undefined) {
    if (!(publicationError instanceof Error)) {
      throw new AbsentFilePublicationError(
        "INVALID_ERROR",
        `Publication failed with an invalid error value: ${displayPath}.`
      );
    }
    throw publicationError;
  }
  if (concurrentSatisfied) {
    return "already-satisfied";
  }
  if (!published) {
    throw new AbsentFilePublicationError(
      "PUBLICATION_INCOMPLETE",
      `Publication did not reach a terminal state: ${displayPath}.`
    );
  }
  if (
    (await classifyExactFilePostimage(
      destinationPath,
      postimage
    )) !== "exact"
  ) {
    throw new AbsentFilePublicationError(
      "VERIFICATION_FAILED",
      `Published file failed verification: ${displayPath}.`
    );
  }
  return "published";
}

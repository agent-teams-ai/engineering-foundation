import { createHash } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  AbsentFilePublicationError,
  type AbsentFilePublicationOutcome,
  type ExactFilePostimage,
  type ExactFilePostimageState
} from "../../application/model/exact-postimage.js";
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
}

const nodeOperations: AbsentFilePublicationOperations = { link };

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

export async function classifyExactFilePostimage(
  destinationPath: string,
  postimage: ExactFilePostimage
): Promise<ExactFilePostimageState> {
  assertValidPostimage(postimage);
  try {
    const result = await readBoundedRegularFile(destinationPath, postimage.size);
    if (result.outcome !== "read") {
      return "conflict";
    }
    const modeMatches =
      process.platform === "win32" ||
      (result.mode & 0o777) === postimage.mode;
    return result.bytes.byteLength === postimage.size &&
      sha256(result.bytes) === postimage.digest &&
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
      await readBoundedRegularFile(entry.temporaryPath, 0);
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
  readonly operations?: AbsentFilePublicationOperations;
  readonly postimage: ExactFilePostimage;
  readonly temporaryPath: string;
}): Promise<AbsentFilePublicationOutcome> {
  assertValidPostimage(options.postimage);
  const operations = options.operations ?? nodeOperations;
  const initial = await classifyExactFilePostimage(
    options.destinationPath,
    options.postimage
  );
  if (initial === "exact") {
    return "already-satisfied";
  }
  if (initial === "conflict") {
    throw new AbsentFilePublicationError(
      "CONFLICT",
      `Destination changed concurrently: ${options.displayPath}.`
    );
  }

  const parent = dirname(options.destinationPath);
  let temporaryIdentity;
  let concurrentSatisfied = false;
  let published = false;
  let publicationError: unknown;
  try {
    const handle = await open(options.temporaryPath, "wx", 0o600).catch(
      (error: unknown) => {
        if (errorCode(error) === "EEXIST") {
          throw new AbsentFilePublicationError(
            "TEMPORARY_EXISTS",
            `Temporary path already exists: ${options.displayPath}.`,
            { cause: error }
          );
        }
        throw error;
      }
    );
    try {
      await handle.writeFile(options.postimage.bytes);
      await options.faultInjector?.({ phase: "after-temporary-written" });
      await handle.chmod(options.postimage.mode);
      await handle.sync();
      temporaryIdentity = await captureFileHandleIdentity(handle);
    } finally {
      await handle.close();
    }
    await options.faultInjector?.({ phase: "after-temporary-synced" });
    try {
      await operations.link(options.temporaryPath, options.destinationPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        if (
          (await classifyExactFilePostimage(
            options.destinationPath,
            options.postimage
          )) === "exact"
        ) {
          concurrentSatisfied = true;
        } else {
          throw new AbsentFilePublicationError(
            "CONFLICT",
            `Destination changed concurrently: ${options.displayPath}.`,
            { cause: error }
          );
        }
      } else if (isUnsupportedLink(error)) {
        throw new AbsentFilePublicationError(
          "PUBLICATION_UNSUPPORTED",
          `Atomic absent-only publication is unsupported: ${options.displayPath}.`,
          { cause: error }
        );
      } else {
        throw error;
      }
    }
    if (!concurrentSatisfied) {
      published = true;
      await options.faultInjector?.({ phase: "after-hard-link" });
      const durability = await syncDirectoryDurably(parent);
      if (
        durability === "unsupported" &&
        options.allowUnsupportedDirectoryDurability !== true
      ) {
        throw new AbsentFilePublicationError(
          "PUBLICATION_UNSUPPORTED",
          `Directory durability is unsupported: ${options.displayPath}.`
        );
      }
    }
  } catch (error) {
    publicationError = error;
  }

  const ownership =
    temporaryIdentity === undefined
      ? "missing"
      : await pathMatchesRegularFileIdentity(
          options.temporaryPath,
          temporaryIdentity
        );
  if (ownership === "match") {
    await rm(options.temporaryPath);
    const durability = await syncDirectoryDurably(parent);
    if (
      durability === "unsupported" &&
      options.allowUnsupportedDirectoryDurability !== true
    ) {
      throw new AbsentFilePublicationError(
        "PUBLICATION_UNSUPPORTED",
        `Directory durability is unsupported: ${options.displayPath}.`
      );
    }
  } else if (ownership === "different") {
    throw new AbsentFilePublicationError(
      "TEMPORARY_REPLACED",
      `Temporary path was replaced concurrently: ${options.displayPath}.`
    );
  }
  if (publicationError !== undefined) {
    if (!(publicationError instanceof Error)) {
      throw new AbsentFilePublicationError(
        "INVALID_ERROR",
        `Publication failed with an invalid error value: ${options.displayPath}.`
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
      `Publication did not reach a terminal state: ${options.displayPath}.`
    );
  }
  if (
    (await classifyExactFilePostimage(
      options.destinationPath,
      options.postimage
    )) !== "exact"
  ) {
    throw new AbsentFilePublicationError(
      "VERIFICATION_FAILED",
      `Published file failed verification: ${options.displayPath}.`
    );
  }
  return "published";
}

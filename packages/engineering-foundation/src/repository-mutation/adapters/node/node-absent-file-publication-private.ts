import { createHash } from "node:crypto";

import {
  AbsentFilePublicationError,
  type ExactFilePostimage,
  type ExactFilePostimageState
} from "../../application/model/exact-postimage.js";
import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import {
  readBoundedRegularFile,
  type BoundedRegularFileRead
} from "./node-bounded-regular-file.js";
import type { DirectoryDurability } from "./node-directory-durability.js";

export function publicationErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export function isMissingPublicationPath(error: unknown): boolean {
  return publicationErrorCode(error) === "ENOENT";
}

export function samePublicationIdentity(
  left: PortablePathIdentity,
  right: PortablePathIdentity
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function exactReadMatchesPostimage(
  result: BoundedRegularFileRead,
  postimage: ExactFilePostimage
): result is Extract<typeof result, { readonly outcome: "read" }> {
  return (
    result.outcome === "read" &&
    result.bytes.byteLength === postimage.size &&
    sha256(result.bytes) === postimage.digest &&
    (process.platform === "win32" ||
      (result.mode & 0o777) === postimage.mode)
  );
}

// Covers the one-shot ctime change when a concurrent publisher unlinks its hard-link temporary.
const maximumUnstableReadRetries = 2;

export async function classifyExactFilePostimageWith(
  readFile: typeof readBoundedRegularFile,
  destinationPath: string,
  postimage: ExactFilePostimage
): Promise<ExactFilePostimageState> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await readFile(destinationPath, postimage.size);
      if (
        result.outcome === "changed" &&
        attempt < maximumUnstableReadRetries
      ) {
        continue;
      }
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
      if (isMissingPublicationPath(error)) {
        return "absent";
      }
      throw error;
    }
  }
}

export async function syncPublicationDirectory(options: {
  readonly allowUnsupportedDirectoryDurability: boolean;
  readonly displayPath: string;
  readonly parent: string;
  readonly syncDirectory: (
    path: string
  ) => Promise<DirectoryDurability>;
}): Promise<void> {
  const durability = await options.syncDirectory(options.parent);
  if (
    durability === "unsupported" &&
    !options.allowUnsupportedDirectoryDurability
  ) {
    throw new AbsentFilePublicationError(
      "PUBLICATION_UNSUPPORTED",
      `Directory durability is unsupported: ${options.displayPath}.`
    );
  }
}

export function assertValidExactPostimage(postimage: ExactFilePostimage): void {
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

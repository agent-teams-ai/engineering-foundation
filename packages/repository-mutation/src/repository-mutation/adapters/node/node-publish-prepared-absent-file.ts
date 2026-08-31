import type { ExactFilePostimage } from "../../application/model/exact-postimage.js";
import { AbsentFilePublicationError } from "../../application/model/exact-postimage.js";
import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import { readBoundedRegularFile } from "./node-bounded-regular-file.js";
import type { DirectoryDurability } from "./node-directory-durability.js";
import {
  classifyExactFilePostimageWith,
  exactReadMatchesPostimage,
  publicationErrorCode,
  samePublicationIdentity,
  syncPublicationDirectory
} from "./node-absent-file-publication-private.js";

function isUnsupportedLink(error: unknown): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(
    publicationErrorCode(error) ?? ""
  );
}

async function verifyPreparedTemporary(options: {
  readonly displayPath: string;
  readonly expectedIdentity: PortablePathIdentity;
  readonly postimage: ExactFilePostimage;
  readonly readBoundedRegularFile: typeof readBoundedRegularFile;
  readonly temporaryPath: string;
}): Promise<void> {
  const stableTemporary = await options.readBoundedRegularFile(
    options.temporaryPath,
    options.postimage.size
  );
  if (
    exactReadMatchesPostimage(stableTemporary, options.postimage) &&
    samePublicationIdentity(stableTemporary.identity, options.expectedIdentity)
  ) {
    return;
  }
  throw new AbsentFilePublicationError(
    "TEMPORARY_REPLACED",
    `Temporary path was replaced or modified concurrently: ${options.displayPath}.`
  );
}

export async function verifyPublishedAbsentFile(options: {
  readonly destinationPath: string;
  readonly displayPath: string;
  readonly expectedIdentity: PortablePathIdentity;
  readonly postimage: ExactFilePostimage;
  readonly readBoundedRegularFile: typeof readBoundedRegularFile;
}): Promise<void> {
  const publishedFile = await options.readBoundedRegularFile(
    options.destinationPath,
    options.postimage.size
  );
  if (
    exactReadMatchesPostimage(publishedFile, options.postimage) &&
    samePublicationIdentity(publishedFile.identity, options.expectedIdentity)
  ) {
    return;
  }
  throw new AbsentFilePublicationError(
    "VERIFICATION_FAILED",
    `Published file failed identity or content verification: ${options.displayPath}.`
  );
}

export interface PublishPreparedAbsentFileOptions {
  readonly allowUnsupportedDirectoryDurability: boolean;
  readonly classifyBoundedRegularFile: typeof readBoundedRegularFile;
  readonly destinationPath: string;
  readonly displayPath: string;
  readonly expectedIdentity: PortablePathIdentity;
  readonly link: (source: string, destination: string) => Promise<void>;
  readonly parent: string;
  readonly postimage: ExactFilePostimage;
  readonly readBoundedRegularFile: typeof readBoundedRegularFile;
  readonly syncDirectory: (
    path: string
  ) => Promise<DirectoryDurability>;
  readonly temporaryPath: string;
}

export async function publishPreparedAbsentFileWithFaults(
  options: PublishPreparedAbsentFileOptions & {
    readonly faultInjector?: (point: {
      readonly phase: "after-hard-link";
    }) => Promise<void> | void;
  }
): Promise<"already-satisfied" | "published"> {
  await verifyPreparedTemporary(options);
  try {
    await options.link(options.temporaryPath, options.destinationPath);
  } catch (error) {
    if (publicationErrorCode(error) === "EEXIST") {
      const state = await classifyExactFilePostimageWith(
        options.classifyBoundedRegularFile,
        options.destinationPath,
        options.postimage
      );
      if (state === "exact") {
        await syncPublicationDirectory(options);
        return "already-satisfied";
      }
      throw new AbsentFilePublicationError(
        "CONFLICT",
        `Destination changed concurrently: ${options.displayPath}.`,
        { cause: error }
      );
    }
    if (isUnsupportedLink(error)) {
      throw new AbsentFilePublicationError(
        "PUBLICATION_UNSUPPORTED",
        `Atomic absent-only publication is unsupported: ${options.displayPath}.`,
        { cause: error }
      );
    }
    throw error;
  }
  await options.faultInjector?.({ phase: "after-hard-link" });
  await verifyPublishedAbsentFile(options);
  await syncPublicationDirectory(options);
  return "published";
}

export function publishPreparedAbsentFile(
  options: PublishPreparedAbsentFileOptions
): Promise<"already-satisfied" | "published"> {
  return publishPreparedAbsentFileWithFaults(options);
}

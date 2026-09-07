import type { KnownFileCoordination } from "./known-file-coordination.js";
import type { FileHandle } from "node:fs/promises";

import { AbsentFilePublicationError, type ExactFilePostimage } from "../../application/model/exact-postimage.js";
import type { PortablePathIdentity } from "../../../path-identity.js";

import { publicationErrorCode } from "./node-absent-file-publication-private.js";

export interface PrepareExactSiblingTemporaryOptions {
  readonly displayPath: string;
  readonly onIdentityCaptured: (identity: PortablePathIdentity) => void;
  readonly validateOpenedPath?: (
    identity: PortablePathIdentity
  ) => Promise<void>;
  readonly open: (
    path: string,
    flags: "wx",
    mode: number
  ) => Promise<FileHandle>;
  readonly postimage: ExactFilePostimage;
  readonly temporaryPath: string;
}

export async function prepareExactSiblingTemporaryWithFaults(coordination: Pick<KnownFileCoordination, "captureFileHandleIdentity">,
  options: PrepareExactSiblingTemporaryOptions & {
    readonly faultInjector?: (point: {
      readonly phase: "after-temporary-written";
    }) => Promise<void> | void;
  }
): Promise<PortablePathIdentity> {
  const handle = await options
    .open(options.temporaryPath, "wx", 0o600)
    .catch((error: unknown) => {
      if (publicationErrorCode(error) === "EEXIST") {
        throw new AbsentFilePublicationError(
          "TEMPORARY_EXISTS",
          `Temporary path already exists: ${options.displayPath}.`,
          { cause: error }
        );
      }
      throw error;
    });
  try {
    const identity = await coordination.captureFileHandleIdentity(handle);
    options.onIdentityCaptured(identity);
    await options.validateOpenedPath?.(identity);
    await handle.writeFile(options.postimage.bytes);
    await options.faultInjector?.({ phase: "after-temporary-written" });
    await handle.chmod(options.postimage.mode);
    await handle.sync();
    return identity;
  } finally {
    await handle.close();
  }
}

export function prepareExactSiblingTemporary(coordination: Pick<KnownFileCoordination, "captureFileHandleIdentity">,
  options: PrepareExactSiblingTemporaryOptions
): Promise<PortablePathIdentity> {
  return prepareExactSiblingTemporaryWithFaults(coordination, options);
}

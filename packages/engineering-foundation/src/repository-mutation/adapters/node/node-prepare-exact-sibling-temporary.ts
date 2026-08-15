import type { FileHandle } from "node:fs/promises";

import { AbsentFilePublicationError, type ExactFilePostimage } from "../../application/model/exact-postimage.js";
import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import { captureFileHandleIdentity } from "./node-bounded-regular-file.js";
import { publicationErrorCode } from "./node-absent-file-publication-private.js";

export async function prepareExactSiblingTemporary(options: {
  readonly displayPath: string;
  readonly faultInjector:
    | ((point: {
        readonly phase: "after-temporary-written";
      }) => Promise<void> | void)
    | undefined;
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
}): Promise<PortablePathIdentity> {
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
    const identity = await captureFileHandleIdentity(handle);
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

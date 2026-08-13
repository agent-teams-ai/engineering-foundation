import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import { pathMatchesRegularFileIdentity } from "./node-bounded-regular-file.js";
import type { DirectoryDurability } from "./node-directory-durability.js";
import { syncPublicationDirectory } from "./node-absent-file-publication-private.js";

export async function cleanupIdentityMatchingOwnedTemporary(options: {
  readonly allowUnsupportedDirectoryDurability: boolean;
  readonly displayPath: string;
  readonly expectedIdentity: PortablePathIdentity;
  readonly parent: string;
  readonly rm: (path: string) => Promise<void>;
  readonly syncDirectory: (
    path: string
  ) => Promise<DirectoryDurability>;
  readonly temporaryPath: string;
}): Promise<"different" | "missing" | "removed"> {
  const ownership = await pathMatchesRegularFileIdentity(
    options.temporaryPath,
    options.expectedIdentity
  );
  if (ownership !== "match") {
    return ownership;
  }
  await options.rm(options.temporaryPath);
  await syncPublicationDirectory(options);
  return "removed";
}

import { randomUUID } from "node:crypto";
import { mkdir, rename, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import { pathMatchesRegularFileIdentity } from "./node-bounded-regular-file.js";
import type { DirectoryDurability } from "./node-directory-durability.js";
import { syncPublicationDirectory } from "./node-absent-file-publication-private.js";

export const OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER =
  ".foundation-owned-cleanup-";

export function ownedTemporaryCleanupResiduePrefix(
  temporaryPath: string
): string {
  return `.${basename(temporaryPath)}${OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER}`;
}

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
  readonly operations?: {
    readonly mkdir?: typeof mkdir;
    readonly pathMatchesRegularFileIdentity?: typeof pathMatchesRegularFileIdentity;
    readonly quarantineToken?: () => string;
    readonly rename?: typeof rename;
    readonly rmdir?: typeof rmdir;
  };
}): Promise<"different" | "missing" | "removed"> {
  const makeDirectory = options.operations?.mkdir ?? mkdir;
  const move = options.operations?.rename ?? rename;
  const removeDirectory = options.operations?.rmdir ?? rmdir;
  const identityMatch = options.operations?.pathMatchesRegularFileIdentity ??
    pathMatchesRegularFileIdentity;
  const token = options.operations?.quarantineToken?.() ?? randomUUID();
  const quarantineDirectory = join(
    options.parent,
    `${ownedTemporaryCleanupResiduePrefix(options.temporaryPath)}${token}`
  );
  const quarantinedPath = join(quarantineDirectory, "owned-temporary");
  try {
    await makeDirectory(quarantineDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return "different";
    }
    throw error;
  }
  try {
    await move(options.temporaryPath, quarantinedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      await removeDirectory(quarantineDirectory);
      await syncPublicationDirectory(options);
      return "missing";
    }
    // The private directory is empty when rename fails. Its removal never
    // touches the source evidence, which remains at the caller-visible path.
    await removeDirectory(quarantineDirectory).catch(() => {});
    throw error;
  }
  // Persist the atomic capture before deciding whether it grants deletion
  // authority. A crash now leaves evidence in the operation-private sibling.
  await syncPublicationDirectory(options);
  const ownership = await identityMatch(
    quarantinedPath,
    options.expectedIdentity
  );
  if (ownership !== "match") {
    return "different";
  }
  await options.rm(quarantinedPath);
  await removeDirectory(quarantineDirectory);
  await syncPublicationDirectory(options);
  return "removed";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

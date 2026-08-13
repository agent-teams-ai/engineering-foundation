import { randomUUID } from "node:crypto";
import { mkdir, rename, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import type { OwnedTemporaryCleanupTransitionPort } from "../../application/ports/owned-temporary-cleanup-transition.js";
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

async function beginCleanupTransition(options: {
  readonly displayPath: string;
  readonly expectedIdentity: PortablePathIdentity;
  readonly identityMatch: typeof pathMatchesRegularFileIdentity;
  readonly temporaryPath: string;
  readonly transition?: OwnedTemporaryCleanupTransitionPort;
}): Promise<
  | { readonly outcome: "different" | "missing" }
  | {
      readonly outcome: "owned";
      readonly transition: Awaited<ReturnType<OwnedTemporaryCleanupTransitionPort["begin"]>> | undefined;
    }
> {
  const initialOwnership = await options.identityMatch(
    options.temporaryPath,
    options.expectedIdentity
  );
  if (initialOwnership !== "match") {
    return { outcome: initialOwnership };
  }
  const transition = await options.transition?.begin();
  if (
    transition !== undefined &&
    (await options.identityMatch(
      options.temporaryPath,
      options.expectedIdentity
    )) !== "match"
  ) {
    throw new Error(
      `Owned temporary changed after its cleanup transition began: ${options.displayPath}.`
    );
  }
  return { outcome: "owned", transition };
}

async function removeEmptyQuarantineAfterMissing(options: {
  readonly cleanupOptions: Parameters<typeof syncPublicationDirectory>[0];
  readonly quarantineDirectory: string;
  readonly removeDirectory: typeof rmdir;
  readonly transition: Awaited<ReturnType<OwnedTemporaryCleanupTransitionPort["begin"]>> | undefined;
}): Promise<"missing"> {
  await options.removeDirectory(options.quarantineDirectory);
  await syncPublicationDirectory(options.cleanupOptions);
  await options.transition?.complete();
  return "missing";
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
  readonly transition?: OwnedTemporaryCleanupTransitionPort;
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
  const begun = await beginCleanupTransition({
    displayPath: options.displayPath,
    expectedIdentity: options.expectedIdentity,
    identityMatch,
    temporaryPath: options.temporaryPath,
    ...(options.transition === undefined
      ? {}
      : { transition: options.transition })
  });
  if (begun.outcome !== "owned") {
    return begun.outcome;
  }
  const { transition } = begun;
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
      return removeEmptyQuarantineAfterMissing({
        cleanupOptions: options,
        quarantineDirectory,
        removeDirectory,
        transition
      });
    }
    // The private directory is empty when rename fails. Its removal never
    // touches the source evidence, which remains at the caller-visible path.
    await removeDirectory(quarantineDirectory).catch(() => {});
    throw error;
  }
  // Persist the atomic capture before deciding whether it grants deletion
  // authority. Rename changes both directories, so durability requires the
  // destination quarantine first and the source parent second.
  await syncCleanupDirectory(options, quarantineDirectory);
  await syncCleanupDirectory(options, options.parent);
  const ownership = await identityMatch(
    quarantinedPath,
    options.expectedIdentity
  );
  if (ownership !== "match") {
    return "different";
  }
  await options.rm(quarantinedPath);
  await syncCleanupDirectory(options, quarantineDirectory);
  await removeDirectory(quarantineDirectory);
  await syncCleanupDirectory(options, options.parent);
  await transition?.complete();
  return "removed";
}

async function syncCleanupDirectory(
  options: {
    readonly allowUnsupportedDirectoryDurability: boolean;
    readonly displayPath: string;
    readonly syncDirectory: (path: string) => Promise<DirectoryDurability>;
  },
  parent: string
): Promise<void> {
  await syncPublicationDirectory({ ...options, parent });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

import { randomUUID } from "node:crypto";
import { link, mkdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";

import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import type { OwnedTemporaryCleanupTransitionPort } from "../../application/ports/owned-temporary-cleanup-transition.js";
import { pathMatchesRegularFileIdentity } from "./node-bounded-regular-file.js";
import type { DirectoryDurability } from "./node-directory-durability.js";
import { syncPublicationDirectory } from "./node-absent-file-publication-private.js";
import {
  assertTerminalEvidenceDirectory,
  ensureTerminalEvidenceDirectory,
  type TerminalEvidenceDirectoryAuthority
} from "./node-terminal-evidence-directory.js";

export const OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER =
  ".foundation-owned-cleanup-";
const OWNED_TEMPORARY_RETIRED_EVIDENCE_MARKER =
  ".foundation-retired-evidence-";

export function ownedTemporaryCleanupResiduePrefix(
  temporaryPath: string
): string {
  return `.${basename(temporaryPath)}${OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER}`;
}

function cleanupOperations(
  operations: Parameters<typeof cleanupIdentityMatchingOwnedTemporary>[0]["operations"]
) {
  return {
    beforeLogicalRetirement: operations?.beforeLogicalRetirement,
    identityMatch:
      operations?.pathMatchesRegularFileIdentity ?? pathMatchesRegularFileIdentity,
    makeDirectory: operations?.mkdir ?? mkdir,
    restore: operations?.link ?? link,
    move: operations?.rename ?? rename,
    token: operations?.quarantineToken?.() ?? randomUUID()
  };
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
  readonly makeDirectory: typeof mkdir;
  readonly quarantineDirectory: string;
  readonly move: typeof rename;
  readonly retiredEvidenceRoot: string;
  readonly retiredDirectory: string;
  readonly transition: Awaited<ReturnType<OwnedTemporaryCleanupTransitionPort["begin"]>> | undefined;
}): Promise<"missing"> {
  const terminalRoot = await ensureTerminalEvidenceDirectory(
    options.retiredEvidenceRoot,
    { mkdir: options.makeDirectory }
  );
  await assertTerminalEvidenceDirectory(terminalRoot);
  await options.move(options.quarantineDirectory, options.retiredDirectory);
  await syncPublicationDirectory(options.cleanupOptions);
  await options.transition?.complete();
  return "missing";
}

async function logicallyRetireQuarantine(options: {
  readonly cleanupOptions: Parameters<typeof syncPublicationDirectory>[0];
  readonly expectedIdentity: PortablePathIdentity;
  readonly identityMatch: typeof pathMatchesRegularFileIdentity;
  readonly move: typeof rename;
  readonly quarantinedPath: string;
  readonly quarantineDirectory: string;
  readonly retiredDirectory: string;
  readonly terminalRoot: TerminalEvidenceDirectoryAuthority;
  readonly beforeLogicalRetirement?: (path: string) => Promise<void> | void;
}): Promise<"different" | "removed"> {
  await options.beforeLogicalRetirement?.(options.quarantinedPath);
  if (
    (await options.identityMatch(
      options.quarantinedPath,
      options.expectedIdentity
    )) !== "match"
  ) {
    return "different";
  }
  await assertTerminalEvidenceDirectory(options.terminalRoot);
  await options.move(options.quarantineDirectory, options.retiredDirectory);
  await syncPublicationDirectory(options.cleanupOptions);
  return "removed";
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
    readonly beforeLogicalRetirement?: (path: string) => Promise<void> | void;
    readonly mkdir?: typeof mkdir;
    readonly link?: typeof link;
    readonly pathMatchesRegularFileIdentity?: typeof pathMatchesRegularFileIdentity;
    readonly quarantineToken?: () => string;
    readonly rename?: typeof rename;
  };
}): Promise<"different" | "missing" | "removed"> {
  const {
    beforeLogicalRetirement,
    identityMatch,
    makeDirectory,
    move,
    restore,
    token
  } = cleanupOperations(options.operations);
  const quarantineDirectory = join(
    options.parent,
    `${ownedTemporaryCleanupResiduePrefix(options.temporaryPath)}${token}`
  );
  const quarantinedPath = join(quarantineDirectory, "owned-temporary");
  const retiredEvidenceRoot = join(
    options.parent,
    OWNED_TEMPORARY_RETIRED_EVIDENCE_MARKER
  );
  const retiredDirectory = join(retiredEvidenceRoot, token);
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
        makeDirectory,
        quarantineDirectory,
        move,
        retiredEvidenceRoot,
        retiredDirectory,
        transition
      });
    }
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
    try {
      await restore(quarantinedPath, options.temporaryPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        return "different";
      }
      throw error;
    }
    await syncCleanupDirectory(options, options.parent);
    return "different";
  }
  const terminalRoot = await ensureTerminalEvidenceDirectory(
    retiredEvidenceRoot,
    { mkdir: makeDirectory }
  );
  await syncCleanupDirectory(options, options.parent);
  // Node exposes no unlink-by-handle or identity-conditional unlink. Moving
  // the whole private directory into a terminal namespace is atomic and can
  // never delete a pathname replacement introduced after the final proof.
  const retirement = await logicallyRetireQuarantine({
    cleanupOptions: options,
    expectedIdentity: options.expectedIdentity,
    identityMatch,
    move,
    quarantinedPath,
    quarantineDirectory,
    retiredDirectory,
    terminalRoot,
    ...(beforeLogicalRetirement === undefined
      ? {}
      : { beforeLogicalRetirement })
  });
  if (retirement === "different") {
    return retirement;
  }
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

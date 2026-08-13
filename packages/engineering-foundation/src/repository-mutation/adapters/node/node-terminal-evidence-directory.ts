import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { PortablePathIdentity } from "../../application/model/path-identity.js";

interface TerminalEvidenceDirectoryStat {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

interface TerminalEvidenceDirectoryOperations {
  readonly lstat: (path: string) => Promise<TerminalEvidenceDirectoryStat>;
  readonly mkdir: typeof mkdir;
  readonly realpath: typeof realpath;
}

export interface TerminalEvidenceDirectoryAuthority {
  readonly identity: PortablePathIdentity;
  readonly path: string;
}

const nodeOperations: TerminalEvidenceDirectoryOperations = {
  lstat: (path) => lstat(path, { bigint: true }),
  mkdir,
  realpath
};

function identityFromStat(
  metadata: TerminalEvidenceDirectoryStat
): PortablePathIdentity {
  return {
    birthtimeNs: metadata.birthtimeNs,
    dev: metadata.dev,
    ino: metadata.ino
  };
}

function identitiesEqual(
  left: PortablePathIdentity,
  right: PortablePathIdentity
): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function observeTerminalEvidenceDirectory(
  path: string,
  operations: TerminalEvidenceDirectoryOperations
): Promise<PortablePathIdentity> {
  const metadata = await operations.lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      "Terminal evidence path must be a real operation-owned directory."
    );
  }
  const expectedCanonicalPath = join(
    await operations.realpath(dirname(path)),
    basename(path)
  );
  if ((await operations.realpath(path)) !== expectedCanonicalPath) {
    throw new Error(
      "Terminal evidence directory resolves outside its expected path."
    );
  }
  const identity = identityFromStat(metadata);
  const after = await operations.lstat(path);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !identitiesEqual(identity, identityFromStat(after))
  ) {
    throw new Error("Terminal evidence directory authority changed.");
  }
  return identity;
}

export async function ensureTerminalEvidenceDirectory(
  path: string,
  operationOverrides: Partial<TerminalEvidenceDirectoryOperations> = {}
): Promise<TerminalEvidenceDirectoryAuthority> {
  const operations = { ...nodeOperations, ...operationOverrides };
  await operations.mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
  });
  return {
    identity: await observeTerminalEvidenceDirectory(path, operations),
    path
  };
}

export async function assertTerminalEvidenceDirectory(
  authority: TerminalEvidenceDirectoryAuthority,
  operationOverrides: Partial<TerminalEvidenceDirectoryOperations> = {}
): Promise<void> {
  const operations = { ...nodeOperations, ...operationOverrides };
  const identity = await observeTerminalEvidenceDirectory(
    authority.path,
    operations
  );
  if (!identitiesEqual(identity, authority.identity)) {
    throw new Error("Terminal evidence directory authority changed.");
  }
}

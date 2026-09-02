import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PortablePathIdentity } from "@agent-teams/repository-mutation";
import { portableRepositoryPathIdentity } from "@agent-teams/repository-mutation";
import { isLexicallyContainedPath } from "@agent-teams/repository-mutation/node";
import { isDocumentRepositoryPath } from "../../application/policies/document-repository-path.js";

interface NodePathAuthorityStat {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface NodePathAuthorityOperations {
  readonly lstat: (path: string) => Promise<NodePathAuthorityStat>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly realpath: (path: string) => Promise<string>;
}

export interface NodeRepositoryRootAuthority {
  readonly canonicalRoot: string;
  readonly identity: PortablePathIdentity;
  readonly lexicalRoot: string;
}

export interface NodeRepositoryDirectoryAuthority {
  readonly ancestry: readonly {
    readonly absolutePath: string;
    readonly identity: PortablePathIdentity;
    readonly repositoryPath: string;
  }[];
  readonly directory: string;
  readonly directoryIdentity: PortablePathIdentity;
  readonly repositoryPath: string;
  readonly root: NodeRepositoryRootAuthority;
}

export interface NodeRepositoryPathAuthority {
  readonly ancestry: NodeRepositoryDirectoryAuthority["ancestry"];
  readonly destinationPath: string;
  readonly parent: string;
  readonly parentIdentity: PortablePathIdentity;
  readonly repositoryPath: string;
  readonly root: NodeRepositoryRootAuthority;
}

const nodeOperations: NodePathAuthorityOperations = {
  lstat: (path) => lstat(path, { bigint: true }),
  readdir,
  realpath
};

// Threat contract: portable Node does not expose mkdirat/linkat/openat2
// confinement through a held directory descriptor. These adapters therefore
// protect cooperative Foundation writers and fail closed on observable moves,
// replacements, and symlink swaps. A malicious same-OS-user process can still
// win an unobservable gap between a proof and a pathname syscall (including
// mkdir -> first lstat, open, and link), and may cause an out-of-root side
// effect before the post-operation proof rejects the result. Such hostile
// syscall racing is outside the portable adapter guarantee. Callers must
// recapture before and after every sensitive operation and must never claim
// ownership, journal evidence, or report publication when either proof differs.

function identity(metadata: NodePathAuthorityStat): PortablePathIdentity {
  const value = {
    birthtimeNs: metadata.birthtimeNs,
    dev: metadata.dev,
    ino: metadata.ino
  };
  if (value.birthtimeNs === 0n || value.dev === 0n || value.ino === 0n) {
    throw new Error("Repository path authority has zero physical identity.");
  }
  return value;
}

export function sameNodePathIdentity(
  left: PortablePathIdentity,
  right: PortablePathIdentity
): boolean {
  return left.birthtimeNs === right.birthtimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino;
}

function assertRealDirectory(
  metadata: NodePathAuthorityStat,
  description: string
): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${description} must be a real directory.`);
  }
}

async function assertNoPortableAlias(
  parent: string,
  segment: string,
  operations: NodePathAuthorityOperations
): Promise<void> {
  const expected = portableRepositoryPathIdentity(segment);
  const entries = await operations.readdir(parent);
  if (entries.some((entry) =>
    entry !== segment && portableRepositoryPathIdentity(entry) === expected)) {
    throw new Error(`Repository ancestry has a portable name collision: ${segment}.`);
  }
}

export async function captureNodeRepositoryRootAuthority(
  consumerRoot: string,
  operations: NodePathAuthorityOperations = nodeOperations
): Promise<NodeRepositoryRootAuthority> {
  const lexicalRoot = resolve(consumerRoot);
  const before = await operations.lstat(lexicalRoot);
  assertRealDirectory(before, "Repository root");
  const beforeIdentity = identity(before);
  const canonicalRoot = await operations.realpath(lexicalRoot);
  const [lexicalAfter, canonicalAfter] = await Promise.all([
    operations.lstat(lexicalRoot),
    operations.lstat(canonicalRoot)
  ]);
  assertRealDirectory(lexicalAfter, "Repository root");
  assertRealDirectory(canonicalAfter, "Canonical repository root");
  const lexicalAfterIdentity = identity(lexicalAfter);
  const canonicalAfterIdentity = identity(canonicalAfter);
  if (
    !sameNodePathIdentity(beforeIdentity, lexicalAfterIdentity) ||
    !sameNodePathIdentity(lexicalAfterIdentity, canonicalAfterIdentity)
  ) {
    throw new Error("Repository root identity changed while it was captured.");
  }
  return Object.freeze({
    canonicalRoot,
    identity: canonicalAfterIdentity,
    lexicalRoot
  });
}

async function captureChildDirectory(
  root: NodeRepositoryRootAuthority,
  parent: string,
  repositoryPath: string,
  segment: string,
  operations: NodePathAuthorityOperations
): Promise<{
  readonly absolutePath: string;
  readonly identity: PortablePathIdentity;
  readonly repositoryPath: string;
}> {
  await assertNoPortableAlias(parent, segment, operations);
  const absolutePath = join(parent, segment);
  const before = await operations.lstat(absolutePath);
  assertRealDirectory(before, `Repository ancestry ${repositoryPath}`);
  const beforeIdentity = identity(before);
  const canonical = await operations.realpath(absolutePath);
  if (resolve(canonical) !== resolve(absolutePath) ||
    !isLexicallyContainedPath(root.canonicalRoot, canonical)) {
    throw new Error("Repository ancestry is redirected or escapes the repository.");
  }
  const after = await operations.lstat(absolutePath);
  assertRealDirectory(after, `Repository ancestry ${repositoryPath}`);
  const afterIdentity = identity(after);
  if (!sameNodePathIdentity(beforeIdentity, afterIdentity)) {
    throw new Error(`Repository ancestry identity changed: ${repositoryPath}.`);
  }
  return Object.freeze({
    absolutePath: canonical,
    identity: afterIdentity,
    repositoryPath
  });
}

export async function captureNodeRepositoryDirectoryAuthority(request: {
  readonly consumerRoot: string;
  readonly operations?: NodePathAuthorityOperations;
  readonly repositoryPath: string;
}): Promise<NodeRepositoryDirectoryAuthority> {
  const operations = request.operations ?? nodeOperations;
  if (request.repositoryPath !== "." &&
    !isDocumentRepositoryPath(request.repositoryPath)) {
    throw new Error("Repository directory is not a portable repository path.");
  }
  const root = await captureNodeRepositoryRootAuthority(
    request.consumerRoot,
    operations
  );
  const ancestry: Array<{
    readonly absolutePath: string;
    readonly identity: PortablePathIdentity;
    readonly repositoryPath: string;
  }> = [{
    absolutePath: root.canonicalRoot,
    identity: root.identity,
    repositoryPath: "."
  }];
  let parent = root.canonicalRoot;
  const traversed: string[] = [];
  if (request.repositoryPath !== ".") {
    for (const segment of request.repositoryPath.split("/")) {
      traversed.push(segment);
      const captured = await captureChildDirectory(
        root,
        parent,
        traversed.join("/"),
        segment,
        operations
      );
      ancestry.push(captured);
      parent = captured.absolutePath;
    }
  }
  const rootAfter = await captureNodeRepositoryRootAuthority(
    request.consumerRoot,
    operations
  );
  if (!sameRootAuthority(root, rootAfter)) {
    throw new Error("Repository root changed while ancestry was captured.");
  }
  const leaf = ancestry.at(-1)!;
  return Object.freeze({
    ancestry: Object.freeze(ancestry),
    directory: leaf.absolutePath,
    directoryIdentity: leaf.identity,
    repositoryPath: request.repositoryPath,
    root
  });
}

export async function captureNodeRepositoryPathAuthority(request: {
  readonly consumerRoot: string;
  readonly operations?: NodePathAuthorityOperations;
  readonly repositoryPath: string;
}): Promise<NodeRepositoryPathAuthority> {
  if (!isDocumentRepositoryPath(request.repositoryPath)) {
    throw new Error("Repository destination is not a portable repository path.");
  }
  const segments = request.repositoryPath.split("/");
  const basename = segments.at(-1)!;
  const parentRepositoryPath = segments.length === 1
    ? "."
    : segments.slice(0, -1).join("/");
  const directory = await captureNodeRepositoryDirectoryAuthority({
    consumerRoot: request.consumerRoot,
    ...(request.operations === undefined ? {} : { operations: request.operations }),
    repositoryPath: parentRepositoryPath
  });
  await assertNoPortableAlias(
    directory.directory,
    basename,
    request.operations ?? nodeOperations
  );
  return Object.freeze({
    ancestry: directory.ancestry,
    destinationPath: join(directory.directory, basename),
    parent: directory.directory,
    parentIdentity: directory.directoryIdentity,
    repositoryPath: request.repositoryPath,
    root: directory.root
  });
}

function sameRootAuthority(
  left: NodeRepositoryRootAuthority,
  right: NodeRepositoryRootAuthority
): boolean {
  return left.canonicalRoot === right.canonicalRoot &&
    left.lexicalRoot === right.lexicalRoot &&
    sameNodePathIdentity(left.identity, right.identity);
}

export function sameNodePathAncestry(
  left: NodeRepositoryDirectoryAuthority["ancestry"],
  right: NodeRepositoryDirectoryAuthority["ancestry"]
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined &&
      entry.absolutePath === other.absolutePath &&
      entry.repositoryPath === other.repositoryPath &&
      sameNodePathIdentity(entry.identity, other.identity);
  });
}

export async function recaptureNodeRepositoryPathAuthority(
  authority: NodeRepositoryPathAuthority,
  operations: NodePathAuthorityOperations = nodeOperations
): Promise<NodeRepositoryPathAuthority> {
  const recaptured = await captureNodeRepositoryPathAuthority({
    consumerRoot: authority.root.lexicalRoot,
    operations,
    repositoryPath: authority.repositoryPath
  });
  if (!sameRootAuthority(authority.root, recaptured.root) ||
    !sameNodePathAncestry(authority.ancestry, recaptured.ancestry) ||
    authority.destinationPath !== recaptured.destinationPath) {
    throw new Error("Repository path authority changed during the operation.");
  }
  return recaptured;
}

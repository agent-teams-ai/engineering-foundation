import { execFileSync } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { repositoryRoot } from "./runtime-policy.mts";
import { withoutGitRepositorySelectors } from "./git-environment.ts";

function within(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative !== "" &&
    childRelative !== "." &&
    childRelative !== ".." &&
    !childRelative.startsWith(`..${sep}`) &&
    !childRelative.includes(sep)
  );
}

export async function assertOwnedProfileRoot(
  candidate: string,
  root: string = repositoryRoot,
): Promise<string> {
  const workspace = resolve(root);
  const workspaceMetadata = await lstat(workspace).catch(() => null);
  if (workspaceMetadata?.isDirectory() !== true || workspaceMetadata.isSymbolicLink()) {
    throw new Error("The profile workspace must be one actual directory.");
  }
  const actualWorkspace = await realpath(workspace);
  if (actualWorkspace !== workspace) {
    throw new Error("The profile workspace has foreign or symbolic-link ancestry.");
  }
  const workerTemporary = resolve(actualWorkspace, ".worker-tmp");
  const profiles = resolve(workerTemporary, "profiles");
  for (const parent of [workerTemporary, profiles]) {
    const metadata = await lstat(parent).catch(() => null);
    if (metadata === null) {
      throw new Error("The disposable profile root parent is unavailable.");
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("A profile parent may not be a symbolic link.");
    }
    if ((await realpath(parent)) !== parent) {
      throw new Error("A profile parent may not have foreign ancestry.");
    }
  }
  const target = resolve(candidate);
  const metadata = await lstat(target).catch(() => null);
  if (metadata?.isSymbolicLink() === true) {
    throw new Error("A profile root may not be a symbolic link.");
  }
  if (!within(profiles, target)) {
    throw new Error("A profile root must be one dedicated child of .worker-tmp/profiles.");
  }
  const parent = await realpath(resolve(target, ".."));
  if (parent !== profiles) {
    throw new Error("A profile root may not traverse a symbolic-link or foreign parent.");
  }
  if (metadata !== null && (!metadata.isDirectory() || (await realpath(target)) !== target)) {
    throw new Error("A profile root must be one actual directory.");
  }
  return target;
}

export interface SourceGitAuthority {
  readonly sourceRoot: string;
  readonly gitDir: string;
  readonly sourceCommit: string;
  readonly environment: NodeJS.ProcessEnv;
}

const MAX_GIT_MARKER_BYTES = 8 * 1024;

function sameMarkerIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readLinkedGitMarker(marker: string, initial: BigIntStats): Promise<string> {
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(marker, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameMarkerIdentity(initial, opened)) {
      throw new Error("Source authority .git marker changed before reading.");
    }
    const bytes = Buffer.alloc(MAX_GIT_MARKER_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) {
        break;
      }
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(marker, { bigint: true });
    if (
      length > MAX_GIT_MARKER_BYTES ||
      BigInt(length) !== initial.size ||
      !sameMarkerIdentity(initial, after) ||
      !sameMarkerIdentity(initial, current)
    ) {
      throw new Error("Source authority .git marker changed or exceeds its bounded size.");
    }
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function assertExplicitSourceGitAuthority(
  sourceRoot: string,
): Promise<SourceGitAuthority> {
  const canonicalSourceRoot = await realpath(sourceRoot);
  const marker = resolve(canonicalSourceRoot, ".git");
  const markerMetadata = await lstat(marker, { bigint: true }).catch(() => null);
  if (markerMetadata === null) {
    throw new Error("Source authority requires an explicit repository .git marker.");
  }
  if (
    markerMetadata.isSymbolicLink() ||
    (!markerMetadata.isDirectory() && !markerMetadata.isFile())
  ) {
    throw new Error("Source authority .git marker must be an actual directory or regular file.");
  }
  let gitDir = marker;
  if (markerMetadata.isFile()) {
    if (markerMetadata.size > BigInt(MAX_GIT_MARKER_BYTES)) {
      throw new Error("Source authority .git marker exceeds its bounded size.");
    }
    const markerSource = await readLinkedGitMarker(marker, markerMetadata);
    const match = /^gitdir:\s*(.+)\s*$/mu.exec(markerSource);
    if (match?.[1] === undefined) {
      throw new Error("Source authority has an invalid linked-worktree .git marker.");
    }
    gitDir = resolve(canonicalSourceRoot, match[1]);
  }
  const environment: NodeJS.ProcessEnv = {
    ...withoutGitRepositorySelectors(),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_DIR: gitDir,
    GIT_WORK_TREE: canonicalSourceRoot,
    GIT_CEILING_DIRECTORIES: dirname(canonicalSourceRoot),
  };
  const observedGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: canonicalSourceRoot,
    env: environment,
    encoding: "utf8",
  }).trim();
  if ((await realpath(observedGitDir)) !== (await realpath(gitDir))) {
    throw new Error("Explicit Git source authority resolved a different Git directory.");
  }
  const observedRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: canonicalSourceRoot,
    env: environment,
    encoding: "utf8",
  }).trim();
  if ((await realpath(observedRoot)) !== canonicalSourceRoot) {
    throw new Error("Explicit Git source authority resolved a different worktree.");
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: canonicalSourceRoot,
    env: environment,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("Explicit Git source authority did not resolve a full source commit.");
  }
  if (!sameMarkerIdentity(markerMetadata, await lstat(marker, { bigint: true }))) {
    throw new Error("Source authority .git marker changed during Git observation.");
  }
  return {
    sourceRoot: canonicalSourceRoot,
    gitDir,
    sourceCommit,
    environment,
  };
}

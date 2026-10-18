import { execFileSync } from "node:child_process";
import { lstat, realpath, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { repositoryRoot } from "./runtime-policy.mts";

function within(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative !== "" &&
    childRelative !== "." &&
    childRelative !== ".." &&
    !childRelative.startsWith(`..${sep}`) &&
    !childRelative.includes(sep);
}

export async function assertOwnedProfileRoot(
  candidate: string,
  root: string = repositoryRoot
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
    if (await realpath(parent) !== parent) {
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
  if (metadata !== null && (!metadata.isDirectory() || await realpath(target) !== target)) {
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

export async function assertExplicitSourceGitAuthority(sourceRoot: string): Promise<SourceGitAuthority> {
  const canonicalSourceRoot = await realpath(sourceRoot);
  const marker = resolve(canonicalSourceRoot, ".git");
  const markerMetadata = await stat(marker).catch(() => null);
  if (markerMetadata === null) {
    throw new Error("Source authority requires an explicit repository .git marker.");
  }
  let gitDir = marker;
  if (markerMetadata.isFile()) {
    const markerSource = await readFile(marker, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/mu.exec(markerSource);
    if (match?.[1] === undefined) {
      throw new Error("Source authority has an invalid linked-worktree .git marker.");
    }
    gitDir = resolve(canonicalSourceRoot, match[1]);
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_DIR: gitDir,
    GIT_WORK_TREE: canonicalSourceRoot,
    GIT_CEILING_DIRECTORIES: dirname(canonicalSourceRoot)
  };
  const observedGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: canonicalSourceRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  if (await realpath(observedGitDir) !== await realpath(gitDir)) {
    throw new Error("Explicit Git source authority resolved a different Git directory.");
  }
  const observedRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: canonicalSourceRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  if (await realpath(observedRoot) !== canonicalSourceRoot) {
    throw new Error("Explicit Git source authority resolved a different worktree.");
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: canonicalSourceRoot,
    env: environment,
    encoding: "utf8"
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("Explicit Git source authority did not resolve a full source commit.");
  }
  return {
    sourceRoot: canonicalSourceRoot,
    gitDir,
    sourceCommit,
    environment
  };
}

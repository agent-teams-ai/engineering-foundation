import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
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

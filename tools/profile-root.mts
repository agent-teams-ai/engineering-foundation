import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { repositoryRoot } from "./runtime-policy.mts";

function within(parent: string, child: string): boolean {
  const relative = child.slice(parent.length);
  return child !== parent && relative.startsWith(sep) &&
    relative.slice(1).split(sep).length === 1;
}

export async function assertOwnedProfileRoot(
  candidate: string,
  root: string = repositoryRoot
): Promise<string> {
  const target = resolve(candidate);
  const profiles = resolve(root, ".worker-tmp/profiles");
  const metadata = await lstat(target).catch(() => null);
  if (metadata?.isSymbolicLink() === true) {
    throw new Error("A profile root may not be a symbolic link.");
  }
  const realProfiles = await realpath(profiles).catch(() => null);
  if (realProfiles === null) {
    throw new Error("The disposable profile root parent is unavailable.");
  }
  if (!within(profiles, target)) {
    throw new Error("A profile root must be one dedicated child of .worker-tmp/profiles.");
  }
  const parent = await realpath(resolve(target, ".."));
  if (parent !== realProfiles) {
    throw new Error("A profile root may not traverse a symbolic-link or foreign parent.");
  }
  return target;
}

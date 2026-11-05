import type { BigIntStats } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, toNamespacedPath } from "node:path";
import { localCustodyFailure } from "../../application/inspection-failures.js";

function isMissingLocalEntry(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Private Node observations of a local lifecycle entry, never durable authority. */
export type LocalEntryObservation =
  | { readonly path: string; readonly metadata: undefined }
  | { readonly path: string; readonly metadata: BigIntStats; readonly linkTarget?: string };

export function sameLocalEntry(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode
  );
}

function sameObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameLocalEntry(left, right) &&
    (left.isDirectory() ||
      (left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs &&
        left.nlink === right.nlink))
  );
}

export async function observeLocalEntry(path: string): Promise<LocalEntryObservation> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissingLocalEntry(error)) {
      return { path, metadata: undefined };
    }
    throw error;
  }
  const linkTarget = metadata.isSymbolicLink() ? await readlink(path) : undefined;
  const after = await lstat(path, { bigint: true });
  if (!sameObservation(metadata, after)) {
    throw localCustodyFailure("Local lifecycle entry changed during observation.");
  }
  return { path, metadata, ...(linkTarget === undefined ? {} : { linkTarget }) };
}

export async function assertLocalEntry(observed: LocalEntryObservation): Promise<void> {
  const current = await observeLocalEntry(observed.path);
  if (
    observed.metadata === undefined
      ? current.metadata !== undefined
      : current.metadata === undefined ||
        !sameObservation(observed.metadata, current.metadata) ||
        observed.linkTarget !== current.linkTarget
  ) {
    throw localCustodyFailure("Local lifecycle entry ownership changed; evidence was preserved.");
  }
}

export function localLinkPointsTo(observed: LocalEntryObservation, target: string): boolean {
  return (
    observed.metadata !== undefined &&
    observed.metadata.isSymbolicLink() &&
    observed.linkTarget !== undefined &&
    toNamespacedPath(resolve(dirname(observed.path), observed.linkTarget)) ===
      toNamespacedPath(resolve(target))
  );
}

/** Binds every existing directory between the canonical consumer and this effect. */
export async function observeLocalParents(root: string, parent: string) {
  const path = relative(root, parent);
  if (
    !isAbsolute(root) ||
    !isAbsolute(parent) ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path) ||
    (await realpath(root)) !== root
  ) {
    throw localCustodyFailure("Local lifecycle parent is outside the canonical consumer.");
  }
  const directories: LocalEntryObservation[] = [];
  let current = root;
  for (const segment of ["", ...path.split(sep).filter(Boolean)]) {
    current = resolve(current, segment);
    const observed = await observeLocalEntry(current);
    if (observed.metadata?.isDirectory() !== true || (await realpath(current)) !== current) {
      throw localCustodyFailure("Local lifecycle parent must be a real consumer directory.");
    }
    directories.push(observed);
  }
  return {
    async assertCurrent(): Promise<void> {
      for (const directory of directories) {
        await assertLocalEntry(directory);
      }
    },
  };
}

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";

export interface StableLocalFile {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly links: string;
}

const retainedAtomicTemporaryPath =
  /^\.agent-teams-local\/\.foundation-retired-evidence-\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/owned-temporary$/u;

function sameLocalFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameLocalFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameLocalFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

// Retained atomic-publication evidence may legitimately have exactly two hard links:
// the original destination and the quarantined owner copy. Ordinary evidence remains
// single-link only. This observer never follows symlinks or accepts a changing inode.
export function readStableLocalEvidenceFile(path: string, name: string): StableLocalFile {
  const beforePath = lstatSync(path, { bigint: true });
  const retainedAtomicTemporary = retainedAtomicTemporaryPath.test(name);
  if (
    !beforePath.isFile() ||
    beforePath.isSymbolicLink() ||
    beforePath.size > 64n * 1024n * 1024n ||
    (beforePath.nlink !== 1n && !(retainedAtomicTemporary && beforePath.nlink === 2n))
  ) {
    throw new Error(
      "Local owner evidence is not one bounded regular file with an admitted link count.",
    );
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const beforeRead = fstatSync(descriptor, { bigint: true });
    if (
      !sameLocalFileIdentity(beforePath, beforeRead) ||
      !sameLocalFileSnapshot(beforePath, beforeRead)
    ) {
      throw new Error("Local owner evidence changed before its read.");
    }
    const content = Buffer.alloc(Number(beforeRead.size));
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, offset);
      if (count === 0) {
        throw new Error("Local owner evidence was truncated during its read.");
      }
      offset += count;
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      !sameLocalFileSnapshot(beforeRead, afterRead) ||
      !sameLocalFileSnapshot(afterRead, afterPath)
    ) {
      throw new Error("Local owner evidence changed during its read.");
    }
    return {
      bytes: content,
      mode: Number(afterRead.mode & 0o777n),
      links: afterRead.nlink.toString(),
    };
  } finally {
    closeSync(descriptor);
  }
}

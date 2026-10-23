import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { reserveStageBytes, type StageByteState } from "./pack-stage-io.mts";
const MAX_MEMBER_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
export function sameFileState(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export async function readStableRegularFile(
  path: string,
  state: StageByteState,
  label: string,
  expected?: { physical: string; pathname: Stats; metadata: Stats },
  maximumBytes = MAX_MEMBER_BYTES,
) {
  const physical = await realpath(path);
  const handle = await open(
    physical,
    fsConstants.O_RDONLY |
      optionalOpenFlag(fsConstants.O_NOFOLLOW) |
      optionalOpenFlag(fsConstants.O_NONBLOCK),
  );
  let reservation;
  try {
    if (expected !== undefined && expected.physical !== physical) {
      throw new Error(`${label} changed before its proved identity was read: ${path}.`);
    }
    const [pathnameBefore, physicalBefore, handleState] = await Promise.all([
      lstat(path),
      lstat(physical),
      handle.stat(),
    ]);
    const opened = handleState;
    if (
      expected !== undefined &&
      (!sameFileState(expected.pathname, pathnameBefore) ||
        !sameFileState(expected.metadata, opened))
    ) {
      throw new Error(`${label} changed before its proved identity was read: ${path}.`);
    }
    if (!sameFileState(physicalBefore, opened)) {
      throw new Error(`${label} changed before staging: ${path}.`);
    }
    if (!opened.isFile() || opened.size > maximumBytes) {
      throw new Error(`${label} contains a non-regular or oversized file: ${path}.`);
    }
    reservation = reserveStageBytes(state, opened.size, label);
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, bytes.length);
    const [after, pathnameAfter, physicalAfter, resolvedAfter] = await Promise.all([
      handle.stat(),
      lstat(path),
      lstat(physical),
      realpath(path),
    ]);
    if (
      bytesRead !== bytes.length ||
      overflowBytes !== 0 ||
      !sameFileState(opened, after) ||
      !sameFileState(pathnameBefore, pathnameAfter) ||
      !sameFileState(opened, physicalAfter) ||
      resolvedAfter !== physical
    ) {
      throw new Error(`${label} changed during staging: ${path}.`);
    }
    reservation.commit();
    return { bytes, mode: opened.mode & 0o777 };
  } finally {
    reservation?.release();
    await handle.close();
  }
}

export async function readBoundedStableJson(path: string, label: string): Promise<unknown> {
  const state = { bytes: 0 };
  const result = await readStableRegularFile(path, state, label, undefined, MAX_MANIFEST_BYTES);
  try {
    return JSON.parse(result.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function optionalOpenFlag(value: number | undefined): number {
  return value ?? 0;
}

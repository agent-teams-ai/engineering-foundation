import { constants, lstat, open, type FileHandle } from "node:fs/promises";

export interface PortableFileIdentity {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}

export type BoundedRegularFileRead =
  | {
      readonly outcome: "read";
      readonly bytes: Buffer;
      readonly identity: PortableFileIdentity;
      readonly mode: number;
    }
  | { readonly outcome: "changed" }
  | { readonly outcome: "invalid" };

function identityFromStat(metadata: {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}): PortableFileIdentity {
  return {
    birthtimeNs: metadata.birthtimeNs,
    dev: metadata.dev,
    ino: metadata.ino
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

interface BigIntFileObservation {
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}

function sameFileObservation(
  left: BigIntFileObservation,
  right: BigIntFileObservation
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

async function readAtMost(
  handle: FileHandle,
  maximumBytes: number
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const remaining = maximumBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  return undefined;
}

export async function readBoundedRegularFile(
  path: string,
  maximumBytes: number
): Promise<BoundedRegularFileRead> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("maximumBytes must be a non-negative safe integer.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      return { outcome: "invalid" };
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)) {
      return { outcome: "invalid" };
    }
    const identity = identityFromStat(before);
    const bytes = await readAtMost(handle, maximumBytes);
    if (bytes === undefined) {
      return { outcome: "invalid" };
    }
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      !sameFileObservation(before, after) ||
      after.size !== BigInt(bytes.byteLength) ||
      (await pathMatchesFileIdentity(path, identity)) !== "match"
    ) {
      return { outcome: "changed" };
    }
    return {
      outcome: "read",
      bytes,
      identity,
      mode: Number(after.mode)
    };
  } finally {
    await handle.close();
  }
}

export async function captureFileHandleIdentity(
  handle: FileHandle
): Promise<PortableFileIdentity> {
  return identityFromStat(await handle.stat({ bigint: true }));
}

export async function pathMatchesFileIdentity(
  path: string,
  expected: PortableFileIdentity
): Promise<"different" | "match" | "missing"> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return "different";
    }
    const observed = identityFromStat(metadata);
    return observed.dev === expected.dev &&
      observed.ino === expected.ino &&
      observed.birthtimeNs === expected.birthtimeNs
      ? "match"
      : "different";
  } catch (error) {
    if (isMissing(error)) {
      return "missing";
    }
    throw error;
  }
}

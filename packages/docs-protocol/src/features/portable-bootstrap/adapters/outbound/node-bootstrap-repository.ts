import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BootstrapRepository } from "../../application/bootstrap-model.js";

const MAXIMUM_OBSERVED_FILE_BYTES = 8 * 1024 * 1024;
function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameObservation(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return sameIdentity(left, right) &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size;
}

async function readAtMost(handle: FileHandle): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAXIMUM_OBSERVED_FILE_BYTES) {
    const remaining = MAXIMUM_OBSERVED_FILE_BYTES + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {return Buffer.concat(chunks, total);}
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return undefined;
}

async function readObservedHandle(
  handle: FileHandle,
  path: string
): Promise<{ readonly bytes: Buffer; readonly mode: number }> {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile()) {
    throw new TypeError(`Portable bootstrap target must be a real regular file: ${path}.`);
  }
  if (opened.nlink !== 1n) {
    throw new TypeError(`Portable bootstrap target must not have multiple hard links: ${path}.`);
  }
  if (opened.size > BigInt(MAXIMUM_OBSERVED_FILE_BYTES)) {
    throw new TypeError(`Portable bootstrap target exceeds the bounded read limit: ${path}.`);
  }
  const bytes = await readAtMost(handle);
  if (bytes === undefined) {
    throw new TypeError(`Portable bootstrap target exceeds the bounded read limit: ${path}.`);
  }
  const after = await handle.stat({ bigint: true });
  const physical = await realpath(path).catch(() => null);
  const pathState = physical === path
    ? await lstat(path, { bigint: true }).catch(() => null)
    : null;
  if (!after.isFile() || after.nlink !== 1n || !sameObservation(opened, after) ||
    after.size !== BigInt(bytes.byteLength) || pathState === null ||
    pathState.isSymbolicLink() || !pathState.isFile() || pathState.nlink !== 1n ||
    !sameObservation(after, pathState)) {
    throw new TypeError(`Portable bootstrap target changed during read: ${path}.`);
  }
  return { bytes, mode: Number(after.mode & 0o777n) };
}

async function canonicalRoot(consumerRoot: string): Promise<string> {
  const requested = resolve(consumerRoot);
  const physical = await realpath(requested);
  const [requestedMetadata, physicalMetadata] = await Promise.all([
    lstat(requested, { bigint: true }),
    lstat(physical, { bigint: true })
  ]);
  if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isDirectory() ||
    physicalMetadata.isSymbolicLink() || !physicalMetadata.isDirectory() ||
    !sameIdentity(requestedMetadata, physicalMetadata)) {
    throw new TypeError("Portable bootstrap consumerRoot must be one real directory, not a symlink.");
  }
  return physical;
}

async function containedTarget(root: string, repositoryPath: string): Promise<string | undefined> {
  const segments = repositoryPath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const identity = segment.normalize("NFC").toLowerCase();
    const entries = await readdir(current);
    const matches = entries.filter((entry) => entry.normalize("NFC").toLowerCase() === identity);
    if (matches.some((entry) => entry !== segment)) {
      throw new TypeError(`Portable bootstrap target has a case or Unicode path alias: ${repositoryPath}.`);
    }
    if (!matches.includes(segment)) {return undefined;}
    const next = join(current, segment);
    if (index === segments.length - 1) {return next;}
    const metadata = await lstat(next);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(next) !== next) {
      throw new TypeError(`Portable bootstrap target has an unsafe repository ancestor: ${repositoryPath}.`);
    }
    current = next;
  }
  return undefined;
}

async function observe(root: string, repositoryPath: string): Promise<{ readonly bytes: Buffer; readonly mode: number } | undefined> {
  const path = await containedTarget(root, repositoryPath);
  if (path === undefined) {return undefined;}
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new TypeError(`Portable bootstrap target must be a real regular file: ${path}.`);
    }
    throw error;
  });
  if (handle === null) {return undefined;}
  try {
    return await readObservedHandle(handle, path);
  } finally {
    await handle.close();
  }
}


export const nodeBootstrapRepository: BootstrapRepository = {
  canonicalRoot,
  async observe(root, repositoryPath) {
    const file = await observe(root, repositoryPath);
    return file === undefined ? undefined : Object.freeze({ contentBase64: file.bytes.toString("base64"), mode: file.mode });
  }
};

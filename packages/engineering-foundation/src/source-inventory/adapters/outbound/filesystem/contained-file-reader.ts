import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

import { ContainedFileReadError } from "../../../application/model/contained-file.js";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

function sameIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

interface FileSnapshot {
  readonly ctimeMs: number | bigint;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number | bigint;
  readonly mtimeMs: number | bigint;
  readonly size: number | bigint;
}

interface ContainedFileHandle {
  close(): Promise<void>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null
  ): Promise<{ readonly bytesRead: number }>;
  stat(): Promise<FileSnapshot & { readonly isFile: () => boolean }>;
}

interface ContainedFileReadOperations {
  readonly lstat: typeof lstat;
  readonly open: (
    path: string,
    flags: number
  ) => Promise<ContainedFileHandle>;
  readonly realpath: typeof realpath;
  readonly stat: (
    path: string
  ) => Promise<FileSnapshot & {
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  }>;
}

const nodeContainedFileReadOperations: ContainedFileReadOperations = {
  lstat,
  async open(path, flags) {
    const handle = await open(path, flags);
    return {
      close: () => handle.close(),
      read: (buffer, offset, length, position) =>
        handle.read(buffer, offset, length, position),
      stat: () => handle.stat({ bigint: true })
    };
  },
  realpath,
  stat: (path) => stat(path, { bigint: true })
};

interface OpenedContainedRegularFile {
  readonly candidate: string;
  readonly expectedBytes: number;
  readonly handle: ContainedFileHandle;
  readonly openedMetadata: FileSnapshot;
  readonly root: string;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    sameIdentity(left, right) &&
    String(left.size) === String(right.size) &&
    String(left.mode) === String(right.mode) &&
    String(left.mtimeMs) === String(right.mtimeMs) &&
    String(left.ctimeMs) === String(right.ctimeMs)
  );
}

function boundedSnapshotSize(
  snapshot: FileSnapshot,
  maxBytes: number
): number | undefined {
  if (typeof snapshot.size === "bigint") {
    return snapshot.size >= 0n && snapshot.size <= BigInt(maxBytes)
      ? Number(snapshot.size)
      : undefined;
  }
  return Number.isSafeInteger(snapshot.size) && snapshot.size >= 0 && snapshot.size <= maxBytes
    ? snapshot.size
    : undefined;
}

function readError(error: unknown, phase: "after-open" | "before-open"): ContainedFileReadError {
  if (error instanceof ContainedFileReadError) {
    return error;
  }
  const code = errorCode(error);
  if (code === "ELOOP") {
    return new ContainedFileReadError("symlink");
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ContainedFileReadError(phase === "before-open" ? "missing" : "changed");
  }
  if (code === "EISDIR") {
    return new ContainedFileReadError("invalid");
  }
  return new ContainedFileReadError("unavailable");
}

function assertByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new ContainedFileReadError("invalid");
  }
}

function containedFileOpenFlags(): number {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  return constants.O_RDONLY | noFollow | nonBlocking;
}

async function assertNoSymbolicLinks(input: {
  readonly candidate: string;
  readonly operations: ContainedFileReadOperations;
  readonly phase: "after-open" | "before-open";
  readonly root: string;
}): Promise<void> {
  if (!contained(input.root, input.candidate)) {
    throw new ContainedFileReadError("escape");
  }
  const relation = relative(input.root, input.candidate);
  let current = input.root;
  for (const segment of relation.split(sep).filter((value) => value.length > 0)) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await input.operations.lstat(current);
    } catch (error) {
      throw readError(error, input.phase);
    }
    if (metadata.isSymbolicLink()) {
      throw new ContainedFileReadError("symlink");
    }
  }
}

async function assertNamedFileMatchesSnapshot(input: {
  readonly candidate: string;
  readonly opened: FileSnapshot;
  readonly operations: ContainedFileReadOperations;
  readonly phase: "after-open" | "before-open";
  readonly root: string;
}): Promise<void> {
  await assertNoSymbolicLinks({
    candidate: input.candidate,
    operations: input.operations,
    phase: input.phase,
    root: input.root
  });
  let canonical: string;
  try {
    canonical = await input.operations.realpath(input.candidate);
  } catch (error) {
    throw readError(error, input.phase);
  }
  if (!contained(input.root, canonical)) {
    throw new ContainedFileReadError("escape");
  }
  let namedMetadata;
  try {
    namedMetadata = await input.operations.stat(canonical);
  } catch (error) {
    throw readError(error, input.phase);
  }
  if (!namedMetadata.isFile() || !sameSnapshot(input.opened, namedMetadata)) {
    throw new ContainedFileReadError("changed");
  }
}

async function readAtMost(input: {
  readonly expectedBytes: number;
  readonly handle: ContainedFileHandle;
}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const readBuffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, input.expectedBytes));
  let bytesReadTotal = 0;
  while (bytesReadTotal < input.expectedBytes) {
    const remaining = input.expectedBytes - bytesReadTotal;
    let result;
    try {
      result = await input.handle.read(
        readBuffer,
        0,
        Math.min(readBuffer.length, remaining),
        bytesReadTotal
      );
    } catch (error) {
      throw readError(error, "after-open");
    }
    if (result.bytesRead === 0) {
      return Buffer.concat(chunks, bytesReadTotal);
    }
    bytesReadTotal += result.bytesRead;
    if (bytesReadTotal > input.expectedBytes) {
      throw new ContainedFileReadError("changed");
    }
    chunks.push(Buffer.from(readBuffer.subarray(0, result.bytesRead)));
  }
  return Buffer.concat(chunks, bytesReadTotal);
}

async function openContainedRegularFile(input: {
  readonly candidate: string;
  readonly maxBytes: number;
  readonly root: string;
}, operations: ContainedFileReadOperations): Promise<OpenedContainedRegularFile> {
  assertByteLimit(input.maxBytes);
  const lexicalRoot = resolve(input.root);
  const lexicalCandidate = resolve(input.candidate);
  if (!contained(lexicalRoot, lexicalCandidate)) {
    throw new ContainedFileReadError("escape");
  }
  let root: string;
  try {
    root = await operations.realpath(lexicalRoot);
    const rootMetadata = await operations.stat(root);
    if (!rootMetadata.isDirectory()) {
      throw new ContainedFileReadError("invalid");
    }
  } catch (error) {
    throw readError(error, "before-open");
  }
  const candidate = resolve(root, relative(lexicalRoot, lexicalCandidate));
  await assertNoSymbolicLinks({
    candidate,
    operations,
    phase: "before-open",
    root
  });
  let handle: ContainedFileHandle;
  try {
    handle = await operations.open(candidate, containedFileOpenFlags());
  } catch (error) {
    throw readError(error, "before-open");
  }
  try {
    const openedMetadata = await handle.stat();
    const expectedBytes = boundedSnapshotSize(openedMetadata, input.maxBytes);
    if (!openedMetadata.isFile() || expectedBytes === undefined) {
      throw new ContainedFileReadError("invalid");
    }
    await assertNamedFileMatchesSnapshot({
      candidate,
      opened: openedMetadata,
      operations,
      phase: "after-open",
      root
    });
    return {
      candidate,
      expectedBytes,
      handle,
      openedMetadata,
      root
    };
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the validation failure that made the handle unusable.
    }
    throw readError(error, "after-open");
  }
}

async function assertOpenedFileStable(
  opened: OpenedContainedRegularFile,
  operations: ContainedFileReadOperations
): Promise<void> {
  const finalMetadata = await opened.handle.stat();
  if (!sameSnapshot(opened.openedMetadata, finalMetadata)) {
    throw new ContainedFileReadError("changed");
  }
  await assertNamedFileMatchesSnapshot({
    candidate: opened.candidate,
    opened: opened.openedMetadata,
    operations,
    phase: "after-open",
    root: opened.root
  });
}

async function closeContainedFile(
  opened: OpenedContainedRegularFile,
  failure?: ContainedFileReadError
): Promise<void> {
  try {
    await opened.handle.close();
  } catch (error) {
    if (failure === undefined) {
      throw readError(error, "after-open");
    }
  }
}

export async function inspectContainedRegularFile(input: {
  readonly candidate: string;
  readonly root: string;
}, operations: ContainedFileReadOperations = nodeContainedFileReadOperations): Promise<{
  readonly size: number;
}> {
  const opened = await openContainedRegularFile({
    ...input,
    maxBytes: Number.MAX_SAFE_INTEGER - 1
  }, operations);
  let failure: ContainedFileReadError | undefined;
  try {
    await assertOpenedFileStable(opened, operations);
  } catch (error) {
    failure = readError(error, "after-open");
  }
  await closeContainedFile(opened, failure);
  if (failure !== undefined) {
    throw failure;
  }
  return { size: opened.expectedBytes };
}

export async function readContainedRegularFile(input: {
  readonly candidate: string;
  readonly maxBytes: number;
  readonly root: string;
}, operations: ContainedFileReadOperations = nodeContainedFileReadOperations): Promise<Buffer> {
  const opened = await openContainedRegularFile(input, operations);
  let bytes: Buffer | undefined;
  let failure: ContainedFileReadError | undefined;
  try {
    bytes = await readAtMost({
      expectedBytes: opened.expectedBytes,
      handle: opened.handle
    });
    if (bytes.length !== opened.expectedBytes) {
      throw new ContainedFileReadError("changed");
    }
    await assertOpenedFileStable(opened, operations);
  } catch (error) {
    failure = readError(error, "after-open");
  }
  await closeContainedFile(opened, failure);
  if (failure !== undefined) {
    throw failure;
  }
  if (bytes === undefined) {
    throw new ContainedFileReadError("unavailable");
  }
  return bytes;
}

export async function pathTraversesSymbolicLink(
  root: string,
  candidate: string
): Promise<boolean> {
  const relation = relative(root, candidate);
  let current = root;
  for (const segment of relation.split(sep).filter((value) => value.length > 0)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

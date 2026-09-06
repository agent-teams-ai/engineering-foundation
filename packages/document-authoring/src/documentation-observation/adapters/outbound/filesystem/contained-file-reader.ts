import { constants } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ContainedFileReadError } from "../../../application/model/contained-file.js";

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code) : undefined;
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." &&
    !relation.startsWith(`..${sep}`));
}

function failure(error: unknown, afterOpen: boolean): ContainedFileReadError {
  if (error instanceof ContainedFileReadError) {
    return error;
  }
  const observed = code(error);
  if (observed === "ELOOP") {
    return new ContainedFileReadError("symlink");
  }
  if (observed === "ENOENT" || observed === "ENOTDIR") {
    return new ContainedFileReadError(afterOpen ? "changed" : "missing");
  }
  if (observed === "EISDIR") {
    return new ContainedFileReadError("invalid");
  }
  return new ContainedFileReadError("unavailable");
}

async function assertNoSymlinks(root: string, candidate: string): Promise<void> {
  if (!contained(root, candidate)) {
    throw new ContainedFileReadError("escape");
  }
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) { throw failure(error, false); }
    if (metadata.isSymbolicLink()) {
      throw new ContainedFileReadError("symlink");
    }
  }
}

async function readStableFile(
  handle: FileHandle,
  root: string,
  candidate: string,
  maxBytes: number
): Promise<Buffer> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)) {
    throw new ContainedFileReadError("invalid");
  }
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  await assertNoSymlinks(root, candidate);
  const named = await stat(await realpath(candidate), { bigint: true });
  const same = before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs && before.dev === named.dev &&
    before.ino === named.ino && before.size === named.size && offset === bytes.length;
  if (!same) {
    throw new ContainedFileReadError("changed");
  }
  return bytes;
}

export async function readContainedRegularFile(input: {
  readonly candidate: string;
  readonly maxBytes: number;
  readonly root: string;
}): Promise<Buffer> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
    throw new ContainedFileReadError("invalid");
  }
  const lexicalRoot = resolve(input.root);
  const lexicalCandidate = resolve(input.candidate);
  if (!contained(lexicalRoot, lexicalCandidate)) {
    throw new ContainedFileReadError("escape");
  }
  let root: string;
  try {
    root = await realpath(lexicalRoot);
    if (!(await stat(root)).isDirectory()) {
      throw new ContainedFileReadError("invalid");
    }
  } catch (error) { throw failure(error, false); }
  const candidate = resolve(root, relative(lexicalRoot, lexicalCandidate));
  await assertNoSymlinks(root, candidate);
  const flags = constants.O_RDONLY |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let handle;
  try { handle = await open(candidate, flags); }
  catch (error) { throw failure(error, false); }
  try {
    return await readStableFile(handle, root, candidate, input.maxBytes);
  } catch (error) { throw failure(error, true); }
  finally { await handle.close().catch(() => {}); }
}

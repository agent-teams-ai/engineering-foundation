import { lstat, mkdir, open, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { FoundationError } from "../../../errors.js";
import { LOCAL_STATE_DIRECTORY } from "../../../foundation-state-contract.js";

export async function ensureFoundationStateDirectory(
  consumerRoot: string
): Promise<string> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Local foundation state path must be a real consumer-owned directory."
      );
    }
    if ((await realpath(directory)) !== directory) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Local foundation state directory resolves outside its expected path."
      );
    }
    return directory;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  try {
    await mkdir(directory);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return ensureFoundationStateDirectory(consumerRoot);
    }
    throw error;
  }
  await syncFoundationStateDirectory(consumerRoot);
  return directory;
}

export async function syncFoundationStateDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Persists recovery-authority metadata without treating unsupported directory
 * fsync as success. Ordinary local state may use the tolerant operation above;
 * transaction cleanup markers must fail closed because their durable presence
 * is what globally excludes another mutation after a crash.
 */
export async function syncFoundationStateDirectoryStrictly(
  path: string
): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function pruneFoundationStateDirectory(
  consumerRoot: string
): Promise<void> {
  try {
    await rmdir(join(consumerRoot, LOCAL_STATE_DIRECTORY));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      return;
    }
    throw error;
  }
}

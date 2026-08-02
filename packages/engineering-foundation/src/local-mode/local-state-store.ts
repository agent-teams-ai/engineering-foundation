import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir
} from "node:fs/promises";
import { join } from "node:path";

import { lock } from "proper-lockfile";

import { FoundationError } from "../errors.js";
import type { FoundationLinkState } from "./types.js";
import {
  LOCAL_OPERATION_LOCK,
  LOCAL_STATE_DIRECTORY,
  LOCAL_STATE_FILE
} from "./types.js";

async function ensureLocalStateDirectory(consumerRoot: string): Promise<string> {
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
      return await ensureLocalStateDirectory(consumerRoot);
    }
    throw error;
  }
  await syncDirectory(consumerRoot);
  return directory;
}

export async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
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

export async function writeLinkState(
  consumerRoot: string,
  state: FoundationLinkState
): Promise<void> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  await ensureLocalStateDirectory(consumerRoot);
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await syncDirectory(directory);
}

async function pruneLocalStateDirectory(consumerRoot: string): Promise<void> {
  try {
    await rmdir(join(consumerRoot, LOCAL_STATE_DIRECTORY));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      return;
    }
    throw error;
  }
}

export async function removeLinkState(consumerRoot: string): Promise<void> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  await rm(destination, { force: true });
  const temporaryEntries = await readdir(directory).catch(() => []);
  await Promise.all(
    temporaryEntries
      .filter((entry) => entry.startsWith(`${LOCAL_STATE_FILE}.`) && entry.endsWith(".tmp"))
      .map(async (entry) => {
        await rm(join(directory, entry), { force: true });
      })
  );
  await syncDirectory(directory);
  await pruneLocalStateDirectory(consumerRoot);
}

export async function acquireFoundationOperationLock(
  consumerRoot: string
): Promise<() => Promise<void>> {
  const directory = await ensureLocalStateDirectory(consumerRoot);
  const lockPath = join(directory, LOCAL_OPERATION_LOCK);
  try {
    const lockEntry = await lstat(lockPath);
    if (!lockEntry.isDirectory() || lockEntry.isSymbolicLink()) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Foundation operation lock path must be a real local directory."
      );
    }
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
    const release = await lock(directory, {
      lockfilePath: lockPath,
      onCompromised: (error) => {
        throw error;
      },
      realpath: true,
      retries: 0,
      stale: 120_000,
      update: 30_000
    });
    return async () => {
      await release();
      await syncDirectory(directory);
      await pruneLocalStateDirectory(consumerRoot);
    };
  } catch (error) {
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Another foundation operation is active or its lock is not safely recoverable.",
      { cause: error }
    );
  }
}

import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecuteWorkflowProcess } from "../../../application/ports/process-execution.js";

/** Git diff may refresh index bytes even with --no-optional-locks. Keep that IO private. */
export async function withGitIndexSnapshot<T>(
  execute: ExecuteWorkflowProcess,
  root: string,
  operation: (read: ExecuteWorkflowProcess) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const index = await execute("git", ["--no-optional-locks", "rev-parse", "--git-path", "index"], {
    cwd: root, strictUtf8: true, ...(signal === undefined ? {} : { signal })
  });
  if (index.exitCode !== 0 || index.stdout.trim().length === 0) {
    throw new Error("Unable to locate the repository index for read-only changed scope.");
  }
  const indexPath = resolve(root, index.stdout.replace(/\r?\n$/u, ""));
  const metadata = await lstat(indexPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return null; }
    throw error;
  });
  if (metadata !== null && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error("Changed scope requires a regular repository index.");
  }
  const owned = await mkdtemp(join(tmpdir(), "foundation-changed-index-"));
  try {
    const snapshot = join(owned, "index");
    if (metadata !== null) {
      await copyFile(indexPath, snapshot, constants.COPYFILE_EXCL);
      // A fresh copy timestamp can hide same-size edits that Git considers racy
      // against the original index timestamp. Round down, never newer than it.
      await utimes(snapshot, metadata.atime, Math.floor(metadata.mtimeMs) / 1_000);
    }
    const read: ExecuteWorkflowProcess = (command, args, options) => execute(command, args, {
      ...options, environment: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_INDEX_FILE: snapshot }
    });
    return await operation(read);
  } finally {
    await rm(owned, { recursive: true });
  }
}

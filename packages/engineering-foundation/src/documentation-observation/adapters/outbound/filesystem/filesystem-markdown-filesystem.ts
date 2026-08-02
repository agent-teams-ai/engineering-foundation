import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { CapabilityInputError } from "../../../../capability-runtime.js";
import { readContainedRegularFile } from "../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";

const MISSING_FILESYSTEM_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);

export interface FilesystemMarkdownOperations {
  readonly lstat: typeof lstat;
  readonly readContainedRegularFile: typeof readContainedRegularFile;
  readonly readdir: typeof readdir;
  readonly realpath: typeof realpath;
  readonly stat: typeof stat;
}

export const nodeFilesystemMarkdownOperations: FilesystemMarkdownOperations = {
  lstat,
  readContainedRegularFile,
  readdir,
  realpath,
  stat
};

function filesystemErrorCode(error: unknown): string | undefined {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    ? error.code
    : undefined;
}

export function isMissingMarkdownFilesystemError(error: unknown): boolean {
  const code = filesystemErrorCode(error);
  return code !== undefined && MISSING_FILESYSTEM_ERROR_CODES.has(code);
}

export function throwMarkdownFilesystemUnavailable(error: unknown, operation: string): never {
  if (error instanceof CapabilityInputError) {
    throw error;
  }
  throw new CapabilityInputError(
    {
      code: "DOCUMENTATION_FILESYSTEM_UNAVAILABLE",
      message: `Documentation filesystem is unavailable while ${operation}.`,
      phase: "documentation-observation",
      retryable: true
    },
    { cause: error }
  );
}

export async function markdownPathTraversesSymbolicLink(
  root: string,
  candidate: string,
  filesystem: FilesystemMarkdownOperations,
  signal?: AbortSignal
): Promise<boolean> {
  const relation = relative(root, candidate);
  let current = root;
  for (const segment of relation.split(sep).filter((value) => value.length > 0)) {
    assertNotCancelled(signal);
    current = join(current, segment);
    let metadata;
    try {
      metadata = await filesystem.lstat(current);
    } catch (error) {
      assertNotCancelled(signal);
      if (isMissingMarkdownFilesystemError(error)) {
        return false;
      }
      throwMarkdownFilesystemUnavailable(error, "checking Markdown paths for symbolic links");
    }
    assertNotCancelled(signal);
    if (metadata.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

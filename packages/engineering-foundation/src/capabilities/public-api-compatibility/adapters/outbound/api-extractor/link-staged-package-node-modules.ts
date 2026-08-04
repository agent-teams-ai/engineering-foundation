import { stat, symlink } from "node:fs/promises";
import { join } from "node:path";

import { CapabilityInputError } from "../../../../../capability-runtime.js";

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "public-api-extraction",
    retryable: false
  });
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Keeps package-local resolution intact without copying dependencies into the
 * snapshot. A sibling stage has the same relative depth as the source package.
 */
export async function linkStagedNodeModules(input: {
  readonly sourceDirectory: string;
  readonly stagedDirectory: string;
}): Promise<void> {
  const sourceNodeModules = join(input.sourceDirectory, "node_modules");
  try {
    if (!(await stat(sourceNodeModules)).isDirectory()) {
      inputError("PUBLIC_API_PATH_INVALID", "Public API package node_modules is not a directory.");
    }
  } catch (error) {
    if (error instanceof CapabilityInputError) {
      throw error;
    }
    if (isMissingPath(error)) {
      return;
    }
    inputError("PUBLIC_API_PATH_UNAVAILABLE", "Public API package node_modules is unavailable.");
  }
  try {
    await symlink(
      sourceNodeModules,
      join(input.stagedDirectory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch {
    inputError(
      "PUBLIC_API_EXTRACTION_FAILED",
      "Unable to link package-local dependencies into the staged package."
    );
  }
}

import { resolve } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { ContainedFileReadError } from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../../strict-yaml.js";
import type { SourceFileSnapshot } from "../../../../../source-inventory/application/model/source-file-snapshot.js";
import { portablePathIsInside } from "../../../application/model/repository-path.js";
import {
  sourceWorkspaceDiscoveryLimits,
  type SourceWorkspaceDiscoveryLimits
} from "./selected-package-source-discovery.js";
import {
  assertSafeRepositoryPath,
  createSourceWorkspaceFileSystem,
  type SourceWorkspaceFileSystem
} from "./source-workspace-filesystem.js";

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "source-workspace-topology",
    retryable: false
  });
}

function sourceReadError(path: string, error: ContainedFileReadError): never {
  if (error.failure === "escape") {
    inputError(
      "SOURCE_DIRECTORY_ESCAPE",
      `Source file escapes the consumer repository: ${path}.`
    );
  }
  if (error.failure === "symlink") {
    inputError(
      "SOURCE_SYMLINK_PROHIBITED",
      `Selected workspace source cannot contain symbolic links: ${path}.`
    );
  }
  if (error.failure === "changed") {
    inputError(
      "SOURCE_FILESYSTEM_CHANGED",
      `Source file changed while it was read: ${path}.`
    );
  }
  if (error.failure === "invalid") {
    inputError(
      "SOURCE_FILE_INVALID",
      `Source file is not a regular file within the supported size limit: ${path}.`
    );
  }
  inputError("SOURCE_FILE_UNAVAILABLE", `Source file is unavailable: ${path}.`);
}

export async function readGovernedSourceFiles(
  canonicalConsumerRoot: string,
  sourcePaths: readonly string[],
  governedRoots: readonly string[],
  options: {
    readonly fileSystem?: Partial<SourceWorkspaceFileSystem>;
    readonly limits?: Partial<SourceWorkspaceDiscoveryLimits>;
    readonly signal?: AbortSignal;
  } = {}
): Promise<readonly SourceFileSnapshot[]> {
  const operations = createSourceWorkspaceFileSystem(options.fileSystem);
  const limits = sourceWorkspaceDiscoveryLimits(options.limits);
  const selectedPaths = sourcePaths
    .filter((path) =>
      governedRoots.some((root) => portablePathIsInside(path, root))
    )
    .toSorted(compareBinaryStrings);
  const snapshots: SourceFileSnapshot[] = [];
  let totalBytes = 0;
  for (const path of selectedPaths) {
    assertNotCancelled(options.signal);
    assertSafeRepositoryPath(path);
    const candidate = resolve(canonicalConsumerRoot, path);
    let bytes: Buffer;
    try {
      bytes = await operations.readContainedFile({
        candidate,
        maxBytes: limits.maxSourceFileBytes,
        root: canonicalConsumerRoot
      });
    } catch (error) {
      if (error instanceof ContainedFileReadError) {
        sourceReadError(path, error);
      }
      throw error;
    }
    assertNotCancelled(options.signal);
    if (totalBytes > limits.maxTotalSourceBytes - bytes.length) {
      inputError(
        "SOURCE_TOTAL_BYTES_EXCEEDED",
        `Selected workspace sources exceed ${limits.maxTotalSourceBytes} total bytes.`
      );
    }
    totalBytes += bytes.length;
    snapshots.push(Object.freeze({ path, source: bytes.toString("utf8") }));
  }
  return Object.freeze(snapshots);
}

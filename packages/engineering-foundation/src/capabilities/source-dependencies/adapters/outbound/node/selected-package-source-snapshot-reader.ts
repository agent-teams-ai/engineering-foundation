import { resolve } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import {
  assertSourceFileByteLimit,
  assertSourceTopologyActive as assertNotCancelled,
  rejectSourceFileRead,
  sourceTopologyInputError as inputError
} from "../../../api.js";
import type { SourceFileSnapshot } from "../../../application/model/source-file-snapshot.js";
import { portablePathIsInside } from "../../../application/model/repository-path.js";
import {
  sourceWorkspaceDiscoveryLimits,
  type SourceWorkspaceDiscoveryLimits
} from "./selected-package-source-discovery.js";
import {
  assertSafeRepositoryPath,
  type SourceWorkspaceFileSystem
} from "./source-workspace-filesystem.js";

export async function readGovernedSourceFiles(
  canonicalConsumerRoot: string,
  sourcePaths: readonly string[],
  governedRoots: readonly string[],
  options: {
    readonly fileSystem: SourceWorkspaceFileSystem;
    readonly limits?: Partial<SourceWorkspaceDiscoveryLimits>;
    readonly signal?: AbortSignal;
  }
): Promise<readonly SourceFileSnapshot[]> {
  const operations = options.fileSystem;
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
    let bytes: Uint8Array;
    try {
      bytes = await operations.readContainedFile({
        candidate,
        maxBytes: limits.maxSourceFileBytes,
        root: canonicalConsumerRoot
      });
    } catch (error) {
      rejectSourceFileRead(error, path);
    }
    assertNotCancelled(options.signal);
    assertSourceFileByteLimit(bytes.byteLength, limits.maxSourceFileBytes, path);
    if (totalBytes > limits.maxTotalSourceBytes - bytes.byteLength) {
      inputError(
        "SOURCE_TOTAL_BYTES_EXCEEDED",
        `Selected workspace sources exceed ${limits.maxTotalSourceBytes} total bytes.`
      );
    }
    totalBytes += bytes.byteLength;
    snapshots.push(Object.freeze({ path, source: Buffer.from(bytes).toString("utf8") }));
  }
  return Object.freeze(snapshots);
}

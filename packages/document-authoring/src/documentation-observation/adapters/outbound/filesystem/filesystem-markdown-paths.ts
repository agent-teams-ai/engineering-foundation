import { isAbsolute, relative, sep } from "node:path";

import { CapabilityInputError } from "../../../../capability-runtime.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import {
  isMissingMarkdownFilesystemError,
  nodeFilesystemMarkdownOperations,
  throwMarkdownFilesystemUnavailable,
  type FilesystemMarkdownOperations
} from "./filesystem-markdown-filesystem.js";

export interface FilesystemMarkdownRepositoryContext {
  readonly canonicalRoot: string;
}

export async function createFilesystemMarkdownRepositoryContext(
  consumerRoot: string,
  filesystem: FilesystemMarkdownOperations = nodeFilesystemMarkdownOperations,
  signal?: AbortSignal
): Promise<FilesystemMarkdownRepositoryContext> {
  assertNotCancelled(signal);
  let canonicalRoot: string;
  let metadata;
  try {
    canonicalRoot = await filesystem.realpath(consumerRoot);
    assertNotCancelled(signal);
    metadata = await filesystem.stat(canonicalRoot);
  } catch (error) {
    assertNotCancelled(signal);
    if (isMissingMarkdownFilesystemError(error)) {
      throw new CapabilityInputError(
        {
          code: "DOCUMENTATION_CONSUMER_ROOT_MISSING",
          message: "Consumer root must be an existing directory.",
          phase: "documentation-observation",
          retryable: false
        },
        { cause: error }
      );
    }
    throwMarkdownFilesystemUnavailable(error, "accessing the consumer root");
  }
  assertNotCancelled(signal);
  if (!metadata.isDirectory()) {
    throw new CapabilityInputError({
      code: "DOCUMENTATION_CONSUMER_ROOT_INVALID",
      message: "Consumer root must be a directory.",
      phase: "documentation-observation",
      retryable: false
    });
  }
  return { canonicalRoot };
}

export function markdownRepositoryPath(
  root: string,
  absolutePath: string
): string {
  return relative(root, absolutePath).split(sep).join("/");
}

export function isWithinMarkdownRepository(
  root: string,
  candidate: string
): boolean {
  const relation = relative(root, candidate);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

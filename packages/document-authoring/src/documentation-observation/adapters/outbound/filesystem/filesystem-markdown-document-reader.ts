import { assertNotCancelled } from "../../../application/policies/cancellation.js";
import { CapabilityInputError } from "../../../application/model/input-problem.js";
import { ContainedFileReadError } from "../../../application/model/contained-file.js";
import type { MarkdownDocumentObservation } from "../../../application/model/markdown-document.js";
import {
  nodeFilesystemMarkdownOperations,
  throwMarkdownFilesystemUnavailable,
  type FilesystemMarkdownOperations
} from "./filesystem-markdown-filesystem.js";
import { markdownRepositoryPath, type FilesystemMarkdownRepositoryContext } from "./filesystem-markdown-paths.js";

import { observeMarkdownDocument } from "./markdown-document-parser.js";

export const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_MARKDOWN_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_MARKDOWN_DOCUMENTS = 10_000;
const MAX_MARKDOWN_LINES = 50_000;
const MAX_MARKDOWN_REFERENCE_MARKERS = 25_000;

export class MarkdownSourceInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownSourceInvalidError";
  }
}

function decodeMarkdownSource(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new MarkdownSourceInvalidError(
      "Markdown source must contain well-formed UTF-8."
    );
  }
}

function resourceLimit(message: string): never {
  throw new CapabilityInputError({
    code: "DOCUMENTATION_RESOURCE_LIMIT_EXCEEDED",
    message,
    phase: "documentation-observation",
    retryable: false
  });
}

function assertDocumentStructureWithinLimits(source: string): void {
  let lines = 1;
  let referenceMarkers = 0;
  for (const character of source) {
    if (character === "\n") {
      lines += 1;
      if (lines > MAX_MARKDOWN_LINES) {
        resourceLimit(`Markdown source exceeds ${MAX_MARKDOWN_LINES} lines.`);
      }
    } else if (character === "[" || character === "<") {
      referenceMarkers += 1;
      if (referenceMarkers > MAX_MARKDOWN_REFERENCE_MARKERS) {
        resourceLimit(
          `Markdown source exceeds ${MAX_MARKDOWN_REFERENCE_MARKERS} potential reference markers.`
        );
      }
    }
  }
}

export class FilesystemMarkdownDocumentReader {
  #cachedBytes = 0;
  readonly #documents = new Map<string, MarkdownDocumentObservation>();
  readonly #filesystem: FilesystemMarkdownOperations;

  constructor(filesystem: FilesystemMarkdownOperations = nodeFilesystemMarkdownOperations) {
    this.#filesystem = filesystem;
  }

  reset(): void {
    this.#cachedBytes = 0;
    this.#documents.clear();
  }

  async read(
    context: FilesystemMarkdownRepositoryContext,
    absolutePath: string,
    signal?: AbortSignal
  ): Promise<MarkdownDocumentObservation | undefined> {
    assertNotCancelled(signal);
    let source: string;
    let sourceBytes: number;
    try {
      const bytes = await this.#filesystem.readContainedRegularFile({
          candidate: absolutePath,
          maxBytes: MAX_MARKDOWN_BYTES,
          root: context.canonicalRoot
        });
      source = decodeMarkdownSource(bytes);
      sourceBytes = bytes.byteLength;
    } catch (error) {
      assertNotCancelled(signal);
      if (error instanceof MarkdownSourceInvalidError) {
        throw error;
      }
      if (
        error instanceof ContainedFileReadError &&
        ["escape", "invalid", "missing", "symlink"].includes(error.failure)
      ) {
        return undefined;
      }
      throwMarkdownFilesystemUnavailable(error, "reading a Markdown source");
    }
    assertNotCancelled(signal);
    const cached = this.#documents.get(absolutePath);
    if (cached?.source === source) {
      return cached;
    }
    assertDocumentStructureWithinLimits(source);
    const previousBytes = cached === undefined
      ? 0
      : Buffer.byteLength(cached.source, "utf8");
    const nextCachedBytes = this.#cachedBytes - previousBytes + sourceBytes;
    const nextDocumentCount = this.#documents.size + (cached === undefined ? 1 : 0);
    if (
      nextCachedBytes > MAX_CACHED_MARKDOWN_BYTES ||
      nextDocumentCount > MAX_CACHED_MARKDOWN_DOCUMENTS
    ) {
      resourceLimit(
        `Markdown cache exceeds ${MAX_CACHED_MARKDOWN_DOCUMENTS} documents or ${MAX_CACHED_MARKDOWN_BYTES} bytes.`
      );
    }
    const document = observeMarkdownDocument(
      markdownRepositoryPath(context.canonicalRoot, absolutePath),
      source
    );
    this.#cachedBytes = nextCachedBytes;
    this.#documents.set(absolutePath, document);
    return document;
  }
}

import { assertNotCancelled } from "../../../../strict-yaml.js";
import { ContainedFileReadError } from "../../../../filesystem-path-safety.js";
import type { MarkdownDocumentObservation } from "../../../application/model/markdown-document.js";
import {
  nodeFilesystemMarkdownOperations,
  throwMarkdownFilesystemUnavailable,
  type FilesystemMarkdownOperations
} from "./filesystem-markdown-filesystem.js";
import type { FilesystemMarkdownRepositoryContext } from "./filesystem-markdown-paths.js";
import { markdownRepositoryPath } from "./filesystem-markdown-paths.js";
import { observeMarkdownDocument } from "./markdown-document-parser.js";

export const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;

export class FilesystemMarkdownDocumentReader {
  readonly #documents = new Map<string, MarkdownDocumentObservation>();
  readonly #filesystem: FilesystemMarkdownOperations;

  constructor(filesystem: FilesystemMarkdownOperations = nodeFilesystemMarkdownOperations) {
    this.#filesystem = filesystem;
  }

  async read(
    context: FilesystemMarkdownRepositoryContext,
    absolutePath: string,
    signal?: AbortSignal
  ): Promise<MarkdownDocumentObservation | undefined> {
    assertNotCancelled(signal);
    let source: string;
    try {
      source = (
        await this.#filesystem.readContainedRegularFile({
          candidate: absolutePath,
          maxBytes: MAX_MARKDOWN_BYTES,
          root: context.canonicalRoot
        })
      ).toString("utf8");
    } catch (error) {
      assertNotCancelled(signal);
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
    const document = observeMarkdownDocument(
      markdownRepositoryPath(context.canonicalRoot, absolutePath),
      source
    );
    this.#documents.set(absolutePath, document);
    return document;
  }
}

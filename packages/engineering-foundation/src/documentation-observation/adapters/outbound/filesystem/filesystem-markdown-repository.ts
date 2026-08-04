import type {
  MarkdownRepositoryObservation,
  MarkdownReferenceResolution
} from "../../../application/model/markdown-document.js";
import type {
  MarkdownRepository,
  ObserveMarkdownRepositoryRequest,
  ResolveMarkdownReferenceRequest
} from "../../../application/ports/markdown-repository.js";
import { FilesystemMarkdownDocumentReader } from "./filesystem-markdown-document-reader.js";
import { resolveFilesystemMarkdownReference } from "./filesystem-markdown-reference-resolver.js";
import { observeFilesystemMarkdownTree } from "./filesystem-markdown-tree-observer.js";

export class FilesystemMarkdownRepository implements MarkdownRepository {
  readonly #documentReader = new FilesystemMarkdownDocumentReader();

  async observe(
    request: ObserveMarkdownRepositoryRequest
  ): Promise<MarkdownRepositoryObservation> {
    return observeFilesystemMarkdownTree(request, this.#documentReader);
  }

  async resolveReference(
    request: ResolveMarkdownReferenceRequest
  ): Promise<MarkdownReferenceResolution> {
    return resolveFilesystemMarkdownReference(request, this.#documentReader);
  }
}

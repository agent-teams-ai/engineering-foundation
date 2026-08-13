import type { DocumentationCatalogSnapshot } from "../model/document-catalog.js";

export interface DocumentationCatalogReadRequest {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

export interface DocumentationCatalogReader {
  execute(
    request: DocumentationCatalogReadRequest
  ): Promise<DocumentationCatalogSnapshot>;
}

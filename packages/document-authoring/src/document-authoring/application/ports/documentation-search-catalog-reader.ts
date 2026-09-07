import type { DocumentationSearchCatalogSnapshot } from "../model/document-catalog.js";

export interface DocumentationCatalogReadRequest {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

export interface DocumentationSearchCatalogReader {
  read(
    request: DocumentationCatalogReadRequest
  ): Promise<DocumentationSearchCatalogSnapshot>;
}

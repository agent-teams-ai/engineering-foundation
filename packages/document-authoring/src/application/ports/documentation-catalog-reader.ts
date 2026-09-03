import type { DocumentationCatalogSnapshotContract } from "../model/document-catalog.js";

interface DocumentationCatalogReadRequest {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

export interface DocumentationCatalogReader {
  execute(
    request: DocumentationCatalogReadRequest
  ): Promise<DocumentationCatalogSnapshotContract>;
}

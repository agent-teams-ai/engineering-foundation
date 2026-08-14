import type { DocumentationCatalogSnapshotV2 } from "../model/document-catalog.js";

export interface DocumentationCatalogReadRequestV2 {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

export interface DocumentationCatalogReaderV2 {
  execute(
    request: DocumentationCatalogReadRequestV2
  ): Promise<DocumentationCatalogSnapshotV2>;
}

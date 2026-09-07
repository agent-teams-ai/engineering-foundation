import type { DocumentationSearchCatalogSnapshotV2 } from "../model/document-catalog.js";

export interface DocumentationSearchCatalogReaderV2 {
  read(request: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentationSearchCatalogSnapshotV2>;
}

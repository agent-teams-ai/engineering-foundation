import type { DocumentAuthorityEvidence } from "../model/document-catalog.js";

export type CatalogCollection =
  | {
      readonly kind: "frontmatter-readme";
      readonly roots: readonly string[];
    }
  | {
      readonly kind: "markdown-tree";
      readonly root: string;
    };

export interface CatalogProfileSnapshot {
  readonly collections: readonly CatalogCollection[];
  readonly evidence: DocumentAuthorityEvidence;
  readonly excludedPrefixes: readonly string[];
  readonly metadataSchemaPath: string;
  readonly ownerCatalog: {
    readonly contract: "foundation.owner-map/v1";
    readonly path: string;
  };
  readonly projectId: string;
}

export interface AuthoringProfileReader {
  read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogProfileSnapshot>;
}

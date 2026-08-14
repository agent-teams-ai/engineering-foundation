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
  readonly artifactOwnerIds?: readonly {
    readonly ids: readonly string[];
    readonly type: string;
  }[];
  readonly collections: readonly CatalogCollection[];
  readonly evidence: DocumentAuthorityEvidence;
  readonly excludedPrefixes: readonly string[];
  readonly metadataSchemaPath: string;
  readonly metadataSidecar?: {
    readonly kind: "path-metadata-map";
    readonly path: string;
  };
  readonly ownerCatalog: {
    readonly contract: "foundation.owner-map/v1";
    readonly path: string;
  };
  readonly projectId: string;
  readonly schemaVersion?: 1 | 2;
  readonly templatePaths?: readonly string[];
}

export interface AuthoringProfileReader {
  read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogProfileSnapshot>;
}

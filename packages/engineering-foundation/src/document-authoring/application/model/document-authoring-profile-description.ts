import type {
  DocumentAuthorityDigest,
  DocumentAuthorityEvidence
} from "./document-catalog.js";
import type {
  DocumentCatalogCollection,
  DocumentIdentityStrategy,
  DocumentPlacementStrategy,
  DocumentReachabilityStrategy
} from "./document-planning.js";

export type DocumentReachabilityStrategyV2 =
  | Exclude<DocumentReachabilityStrategy, { readonly kind: "not-required" }>
  | {
      readonly kind: "not-required";
      readonly reason: string;
    };

export interface DocumentAuthoringTypeDescriptionV2 {
  readonly allowedOwnerIds: readonly string[];
  readonly heading: { readonly kind: "id-colon-title" | "title" };
  readonly identity: DocumentIdentityStrategy;
  readonly initialStatus: string;
  readonly placement: DocumentPlacementStrategy;
  readonly reachability: DocumentReachabilityStrategyV2;
  readonly requiredMetadata: readonly string[];
  readonly template: {
    readonly kind: "fenced-markdown-body";
    readonly path: string;
  };
  readonly type: string;
}

export interface DocumentAuthoringProfileDescriptionV2 {
  readonly authority: {
    readonly metadataSchema: DocumentAuthorityEvidence;
    readonly metadataSidecar?: DocumentAuthorityEvidence;
    readonly ownerCatalog: DocumentAuthorityEvidence;
    readonly profile: DocumentAuthorityEvidence;
    readonly templates: readonly {
      readonly evidence: DocumentAuthorityEvidence;
      readonly type: string;
    }[];
  };
  readonly authorityPaths: {
    readonly metadataSchema: string;
    readonly metadataSidecar?: string;
    readonly ownerCatalog: string;
    readonly profile: string;
  };
  readonly catalog: {
    readonly collections: readonly DocumentCatalogCollection[];
    readonly excludedPrefixes: readonly string[];
  };
  readonly ownerIds: readonly string[];
  readonly projectId: string;
  readonly profileSchemaVersion: 2 | 3;
  readonly schemaVersion: 2;
  readonly semanticDigest: DocumentAuthorityDigest;
  readonly types: readonly DocumentAuthoringTypeDescriptionV2[];
}

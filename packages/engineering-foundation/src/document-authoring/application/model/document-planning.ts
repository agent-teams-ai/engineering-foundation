import type {
  DocumentAuthorityDigest,
  DocumentAuthorityEvidence,
  DocumentIdentityProjectionEntry,
  DocumentationCatalogSnapshot
} from "./document-catalog.js";

export type DocumentJsonPrimitive = boolean | null | number | string;
export interface DocumentJsonObject {
  readonly [key: string]: DocumentJsonValue;
}
export type DocumentJsonValue =
  | DocumentJsonPrimitive
  | readonly DocumentJsonValue[]
  | DocumentJsonObject;

export interface DocumentIntent {
  readonly schemaVersion: 1;
  readonly type: string;
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly summary: string;
  readonly slug?: string;
  readonly destination?: string;
  readonly related?: readonly string[];
  readonly additionalMetadata?: Readonly<Record<string, DocumentJsonValue>>;
}

export type DocumentIdentityStrategy =
  | {
      readonly kind: "explicit";
      readonly format: "adr-four-digits" | "open-decision-three-digits";
    }
  | {
      readonly kind: "explicit";
      readonly format: "qualified";
      readonly grammar: {
        readonly prefixSegments: readonly string[];
        readonly minSuffixSegments: number;
        readonly maxSuffixSegments: number;
      };
    };

export type DocumentPlacementStrategy =
  | {
      readonly kind: "collection";
      readonly directory: string;
      readonly filename: "numeric-id-slug" | "id-slug" | "slug" | "README.md";
    }
  | {
      readonly kind: "qualified-leaf-index";
      readonly root: string;
      readonly requiredBasename: "README.md";
    }
  | {
      readonly kind: "explicit";
      readonly allowedRoots: readonly string[];
      readonly requiredSegmentsInOrder: readonly string[];
      readonly requiredBasename: "README.md";
      readonly minimumSegmentsBeforeRequired: number;
      readonly minimumSegmentsAfterRequired: number;
    };

export interface DocumentArtifactType {
  readonly type: string;
  readonly initialStatus: string;
  readonly identity: DocumentIdentityStrategy;
  readonly placement: DocumentPlacementStrategy;
  readonly template: {
    readonly kind: "fenced-markdown-body";
    readonly path: string;
  };
  readonly heading: {
    readonly kind: "id-colon-title" | "title";
  };
  readonly reachability: DocumentReachabilityStrategy;
}

export type DocumentReachabilityStrategy =
  | {
      readonly kind: "manual-fixed-index";
      readonly indexPath: string;
    }
  | {
      readonly kind: "manual-colocated-index";
      readonly pathPrefix: "before-required-segments";
      readonly indexBasename: "README.md";
    }
  | { readonly kind: "not-required" };

export type DocumentCatalogCollection =
  | {
      readonly kind: "frontmatter-readme";
      readonly roots: readonly string[];
    }
  | {
      readonly kind: "markdown-tree";
      readonly root: string;
    };

export interface DocumentPlanningProfileSnapshot {
  readonly artifactTypes: readonly DocumentArtifactType[];
  readonly collections: readonly DocumentCatalogCollection[];
  readonly evidence: DocumentAuthorityEvidence;
  readonly excludedPrefixes: readonly string[];
  readonly metadataSchemaPath: string;
  readonly ownerCatalog: {
    readonly contract: "foundation.owner-map/v1";
    readonly path: string;
  };
  readonly projectId: string;
}

export interface DocumentTemplateSnapshot {
  readonly evidence: DocumentAuthorityEvidence;
  readonly source: string;
}

export interface DocumentCompilerIdentity {
  readonly id: "@agent-teams/engineering-foundation";
  readonly version: string;
  readonly buildIdentity: DocumentAuthorityDigest;
}

type DocumentDestinationObservation =
  | { readonly state: "absent" }
  | { readonly state: "regular-file"; readonly bytes: Uint8Array }
  | {
      readonly state: "conflict";
      readonly kind: "directory" | "portable-name-collision" | "special-file";
    };

export interface DocumentPlanningStateSnapshot {
  readonly destination: DocumentDestinationObservation;
  readonly expectedParent: {
    readonly path: string;
    readonly state: "directory";
    readonly ancestry: "real-directories";
  };
}

export interface DocumentPlanDiagnostic {
  readonly ruleId: string;
  readonly severity: "error" | "info" | "warning";
  readonly phase: "authority" | "input" | "planning" | "policy";
  readonly subject: string;
  readonly message: string;
}

export interface DocumentPlan {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly compiler: DocumentCompilerIdentity;
  readonly projectId: string;
  readonly intent: DocumentIntent;
  readonly intentDigest: DocumentAuthorityDigest;
  readonly authority: {
    readonly profile: DocumentAuthorityEvidence;
    readonly metadataSchema: DocumentAuthorityEvidence;
    readonly ownerCatalog: DocumentAuthorityEvidence;
    readonly template: DocumentAuthorityEvidence;
  };
  readonly selectedOwner: {
    readonly id: string;
    readonly membershipDigest: DocumentAuthorityDigest;
  };
  readonly identityProjection: {
    readonly entryCount: number;
    readonly digest: DocumentAuthorityDigest;
  };
  readonly referencedDocuments: readonly {
    readonly id: string;
    readonly path: string;
    readonly projectionDigest: DocumentAuthorityDigest;
  }[];
  readonly destination: string;
  readonly expectedParent: {
    readonly path: string;
    readonly state: "directory";
    readonly ancestry: "real-directories";
  };
  readonly destinationPrecondition: { readonly state: "absent" };
  readonly output: {
    readonly digest: DocumentAuthorityDigest;
    readonly size: number;
    readonly mode: "0644";
    readonly mediaType: "text/markdown; charset=utf-8";
    readonly contentBase64: string;
  };
  readonly requiredAdapterCapabilities: readonly ["create-file-no-replace/v1"];
  readonly diagnostics: readonly DocumentPlanDiagnostic[];
  readonly planDigest: DocumentAuthorityDigest;
}

export interface DocumentPlanningCompilationInput {
  readonly catalog: DocumentationCatalogSnapshot;
  readonly compiler: DocumentCompilerIdentity;
  readonly identityProjection: readonly DocumentIdentityProjectionEntry[];
  readonly intent: DocumentIntent;
  readonly metadataSchema: DocumentAuthorityEvidence;
  readonly ownerCatalog: DocumentAuthorityEvidence;
  readonly profile: DocumentPlanningProfileSnapshot;
  readonly state: DocumentPlanningStateSnapshot;
  readonly template: DocumentTemplateSnapshot;
  readonly output: string;
}

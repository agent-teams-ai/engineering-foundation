export type DocumentAuthorityDigest = `sha256:${string}`;

export interface DocumentAuthorityEvidence {
  readonly digest: DocumentAuthorityDigest;
  readonly path: string;
  readonly size: number;
}

export interface DocumentDescriptor {
  readonly id: string;
  readonly owner: string;
  readonly repositoryPath: string;
  readonly source: "frontmatter-readme" | "markdown-tree";
  readonly status: string;
  readonly summary: string;
  readonly title: string;
  readonly type: string;
}

export type DocumentMetadataPrimitive = boolean | null | number | string;
export interface DocumentMetadataObject {
  readonly [key: string]: DocumentMetadataValue;
}
export type DocumentMetadataValue =
  | DocumentMetadataPrimitive
  | readonly DocumentMetadataValue[]
  | DocumentMetadataObject;

export interface DocumentDescriptorV2 extends DocumentDescriptor {
  readonly metadata: DocumentMetadataObject;
}

export interface DocumentIdentityProjectionEntry {
  readonly id: string;
  readonly repositoryPath: string;
}

export interface ReferencedDocumentProjection {
  readonly id: string;
  readonly path: string;
}

export interface DocumentationCatalogDiagnostic {
  readonly message: string;
  readonly ruleId: string;
  readonly severity: "error";
  readonly subject: string;
}

export interface DocumentationCatalogAuthority {
  readonly metadataSchema: DocumentAuthorityEvidence;
  readonly ownerCatalog: DocumentAuthorityEvidence;
  readonly profile: DocumentAuthorityEvidence;
}

export interface DocumentationCatalogAuthorityV2
  extends DocumentationCatalogAuthority {
  readonly metadataSidecar?: DocumentAuthorityEvidence;
}

export interface DocumentationCatalogSnapshot {
  readonly authority: DocumentationCatalogAuthority;
  readonly diagnostics: readonly DocumentationCatalogDiagnostic[];
  readonly documents: readonly DocumentDescriptor[];
  readonly identityProjection: readonly DocumentIdentityProjectionEntry[];
  readonly ownerIds: readonly string[];
  readonly projectId: string;
  readonly status: "complete" | "partial";
}

export interface DocumentationCatalogSnapshotV2
  extends Omit<DocumentationCatalogSnapshot, "authority" | "documents"> {
  readonly authority: DocumentationCatalogAuthorityV2;
  readonly documents: readonly DocumentDescriptorV2[];
  readonly semanticDigest: DocumentAuthorityDigest;
}

export type DocumentationCatalogSnapshotContract = Omit<
  DocumentationCatalogSnapshot,
  "authority"
> & {
  readonly authority: DocumentationCatalogAuthority & {
    readonly metadataSidecar?: DocumentAuthorityEvidence;
  };
  readonly semanticDigest?: DocumentAuthorityDigest;
};

export interface DocumentSearchCorpusEntry {
  readonly body: string;
  readonly descriptor: DocumentDescriptor;
  readonly headings: readonly string[];
}

export interface DocumentationSearchCatalogSnapshot {
  readonly catalog: DocumentationCatalogSnapshot;
  readonly documents: readonly DocumentSearchCorpusEntry[];
}

export interface DocumentSearchCorpusEntryV2
  extends Omit<DocumentSearchCorpusEntry, "descriptor"> {
  readonly descriptor: DocumentDescriptorV2;
}

export interface DocumentationSearchCatalogSnapshotV2 {
  readonly catalog: DocumentationCatalogSnapshotV2;
  readonly documents: readonly DocumentSearchCorpusEntryV2[];
}

export interface ReferencedDocumentProjectionResult {
  readonly documents: readonly ReferencedDocumentProjection[];
  readonly missingIds: readonly string[];
  readonly unresolvedIds: readonly string[];
}

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
  readonly source: string;
  readonly status: string;
  readonly summary: string;
  readonly title: string;
  readonly type: string;
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

export interface DocumentationCatalogSnapshot {
  readonly authority: DocumentationCatalogAuthority;
  readonly diagnostics: readonly DocumentationCatalogDiagnostic[];
  readonly documents: readonly DocumentDescriptor[];
  readonly identityProjection: readonly DocumentIdentityProjectionEntry[];
  readonly ownerIds: readonly string[];
  readonly projectId: string;
  readonly status: "complete" | "partial";
}

export interface ReferencedDocumentProjectionResult {
  readonly documents: readonly ReferencedDocumentProjection[];
  readonly missingIds: readonly string[];
}

import type {
  DocumentAuthorityDigest,
  DocumentDescriptor,
  DocumentDescriptorV2,
  DocumentationCatalogDiagnostic
} from "./document-catalog.js";

export interface DocumentFindFilters {
  readonly id?: string;
  readonly owner?: string;
  readonly status?: string;
  readonly type?: string;
}

export interface DocumentFindQuery {
  readonly filters?: DocumentFindFilters;
  readonly text?: string;
}

export interface DocumentFindResult {
  readonly catalogStatus: "complete" | "partial";
  readonly diagnostics: readonly DocumentationCatalogDiagnostic[];
  readonly documents: readonly DocumentDescriptor[];
  readonly matches: number;
}

export interface DocumentFindResultV2
  extends Omit<DocumentFindResult, "documents"> {
  readonly catalogSemanticDigest: DocumentAuthorityDigest;
  readonly documents: readonly DocumentDescriptorV2[];
}

import type {
  DocumentDescriptor,
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

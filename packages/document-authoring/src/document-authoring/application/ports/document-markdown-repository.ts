import type {
  MarkdownDocumentObservation,
  MarkdownReferenceResolution,
  MarkdownRepositoryObservation
} from "../../../documentation-observation/api.js";

export interface DocumentMarkdownRepository {
  observe(request: {
    readonly consumerRoot: string;
    readonly excludedPrefixes?: readonly string[];
    readonly roots: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<MarkdownRepositoryObservation>;
  resolveReference(request: {
    readonly consumerRoot: string;
    readonly rawTarget: string;
    readonly signal?: AbortSignal;
    readonly source: MarkdownDocumentObservation;
  }): Promise<MarkdownReferenceResolution>;
}

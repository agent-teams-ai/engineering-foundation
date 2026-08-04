import type {
  MarkdownDocumentObservation,
  MarkdownReferenceResolution,
  MarkdownRepositoryObservation
} from "../model/markdown-document.js";

export interface ObserveMarkdownRepositoryRequest {
  readonly consumerRoot: string;
  readonly roots: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ResolveMarkdownReferenceRequest {
  readonly consumerRoot: string;
  readonly rawTarget: string;
  readonly signal?: AbortSignal;
  readonly source: MarkdownDocumentObservation;
}

export interface MarkdownRepository {
  observe(
    request: ObserveMarkdownRepositoryRequest
  ): Promise<MarkdownRepositoryObservation>;
  resolveReference(
    request: ResolveMarkdownReferenceRequest
  ): Promise<MarkdownReferenceResolution>;
}

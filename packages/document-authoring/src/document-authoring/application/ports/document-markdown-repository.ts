import type {
  MarkdownRepositoryObservation
} from "../../../documentation-observation/api.js";

export interface DocumentMarkdownRepository {
  observe(request: {
    readonly consumerRoot: string;
    readonly excludedPrefixes?: readonly string[];
    readonly roots: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<MarkdownRepositoryObservation>;
}

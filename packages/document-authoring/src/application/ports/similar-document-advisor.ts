export interface SimilarDocumentAdvice {
  readonly matches: readonly {
    readonly id: string;
    readonly repositoryPath: string;
  }[];
  readonly query: string;
}

/** Read-only, deterministic pre-planning discovery seam. */
export interface SimilarDocumentAdvisor {
  advise(request: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly title: string;
    readonly signal?: AbortSignal;
  }): Promise<SimilarDocumentAdvice>;
}

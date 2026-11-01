/** Independent filesystem observations; no governed-root or lint selection filter. */
export interface SourceCensusReader {
  read(input: {
    readonly consumerRoot: string;
    readonly roots: readonly string[];
    /** Explicit full-input observation; ordinary source discovery keeps its defaults. */
    readonly generatedDirectories?: "observe";
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly sourcePaths: readonly string[];
    readonly filePaths: readonly string[];
    readonly manifestPaths: readonly string[];
  }>;
}

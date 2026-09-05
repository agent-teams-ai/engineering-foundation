import type { DocsFindQueryV3 } from "@agent-teams/docs-protocol";

export interface DocsBinding {
  readonly consumerRoot: string;
  readonly profilePath: string;
}

export interface DocsReadExecution {
  readonly envelope: {
    readonly schemaVersion: number;
    readonly protocol: Readonly<Record<string, unknown>>;
    readonly command: string;
    readonly outcome: string;
    readonly diagnostics: readonly unknown[];
    readonly result: unknown;
  };
  readonly exitCode: number;
}

export interface DocsReader {
  info(input: DocsBinding & { readonly signal?: AbortSignal }): Promise<DocsReadExecution>;
  find(input: DocsBinding & {
    readonly query: DocsFindQueryV3;
    readonly signal?: AbortSignal;
  }): Promise<DocsReadExecution>;
  context(input: DocsBinding & {
    readonly query: DocsFindQueryV3;
    readonly limits: {
      readonly maxBytes: number;
      readonly maxDocuments: number;
    };
    readonly signal?: AbortSignal;
  }): Promise<DocsReadExecution>;
}

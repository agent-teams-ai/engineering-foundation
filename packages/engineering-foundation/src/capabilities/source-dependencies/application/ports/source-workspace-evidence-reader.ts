export interface SourceWorkspaceFileReader {
  readonly read: (input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }) => Promise<Uint8Array>;
}

export type SourceWorkspaceManifestLoader = (
  consumerRoot: string,
  repositoryPath: string,
  phase: string,
  signal?: AbortSignal
) => Promise<unknown>;

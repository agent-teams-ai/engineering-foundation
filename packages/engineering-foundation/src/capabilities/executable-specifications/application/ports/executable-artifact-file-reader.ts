export interface ExecutableArtifactFileReader {
  readonly read: (input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }) => Promise<Uint8Array>;
}

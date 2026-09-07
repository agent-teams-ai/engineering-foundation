// Caller-owned port: configuration loading needs bounded bytes, not a Node handle.
export interface ConfigurationFileReader {
  readonly read: (input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }) => Promise<Uint8Array>;
}

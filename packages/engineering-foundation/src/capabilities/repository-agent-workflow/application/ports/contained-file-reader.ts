/** Contained regular-file content reads required for mutable input custody.
 * Composition injects the source-inventory reader; this layer declares no
 * filesystem dependency of its own. */
export interface ContainedFileReader {
  read(input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }): Promise<Uint8Array>;
}

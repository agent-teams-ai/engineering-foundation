/** Content and metadata observations required for instruction selection. */
export interface EffectiveInstructionFileObservation {
  read(input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }): Promise<Uint8Array>;

  inspect(input: {
    readonly candidate: string;
    readonly root: string;
  }): Promise<{ readonly size: number }>;
}

export interface BufQualificationObservation {
  readonly read: (input: {
    readonly root: string;
    readonly candidate: string;
    readonly maxBytes: number;
  }) => Promise<Uint8Array>;
  readonly parseYaml: (source: string, phase: string) => unknown;
}

export interface SecurityEvidenceObservation {
  readonly read: (input: {
    readonly root: string;
    readonly candidate: string;
    readonly maxBytes: number;
  }) => Promise<Uint8Array>;
  readonly traversesSymbolicLink: (root: string, candidate: string) => Promise<boolean>;
  readonly parseYaml: (source: string, phase: string) => unknown;
}

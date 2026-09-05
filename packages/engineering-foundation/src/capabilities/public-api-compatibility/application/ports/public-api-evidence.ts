export interface PublicApiFileReader {
  read(input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }): Promise<Uint8Array>;
}

export interface PublicApiPathInspection {
  traversesSymbolicLink(root: string, candidate: string): Promise<boolean>;
}

export interface PublicApiSourceEvidence {
  readonly files: PublicApiFileReader;
  readonly paths: PublicApiPathInspection;
}

export interface PublicApiRepositoryEvidence extends PublicApiSourceEvidence {
  readonly parseYaml: (source: string, phase: string) => unknown;
}

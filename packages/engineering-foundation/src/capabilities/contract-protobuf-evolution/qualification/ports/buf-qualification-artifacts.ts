export type BufQualificationEvidenceWriteResult = "created" | "updated" | "unchanged";

export interface BufQualificationArtifacts {
  readInput(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly maxBytes: number;
    readonly label: string;
  }): Promise<Uint8Array>;
  readExistingEvidence(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly maxBytes: number;
  }): Promise<string | undefined>;
  writeEvidence(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly source: string;
    readonly signal?: AbortSignal;
  }): Promise<BufQualificationEvidenceWriteResult>;
}

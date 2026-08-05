export interface BufQualificationRunInput {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly expectedVersion: string;
  readonly modulePath: string;
  readonly bufConfigPath: string;
  readonly baselineDescriptorImage: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface BufQualificationRunResult {
  readonly status: "compatible" | "breaking";
  readonly candidateDescriptorImage: Uint8Array;
  readonly rawOutput: string;
}

export interface BufQualificationRunner {
  run(input: BufQualificationRunInput): Promise<BufQualificationRunResult>;
}

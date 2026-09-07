/** Physical observations required by the baseline repository, without write authority. */
export interface ArchitectureDecisionBaselineObservation {
  read(input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }): Promise<Buffer>;

  pathTraversesSymbolicLink(root: string, candidate: string): Promise<boolean>;
}

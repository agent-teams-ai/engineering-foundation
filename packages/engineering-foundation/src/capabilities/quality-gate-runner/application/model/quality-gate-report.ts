type QualityGateTaskOutcome =
  | "passed"
  | "failed"
  | "timed-out"
  | "blocked"
  | "cancelled";

export interface QualityGateTaskReport {
  readonly id: string;
  readonly outcome: QualityGateTaskOutcome;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failureTail: string;
}

export interface QualityGateRunReport {
  readonly reportSchemaVersion: 1;
  readonly profileId: string;
  readonly outcome: "passed" | "failed" | "cancelled";
  readonly durationMs: number;
  readonly tasks: readonly QualityGateTaskReport[];
}

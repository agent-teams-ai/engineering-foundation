export interface AcceptedArchitectureDecisionEvidence {
  readonly acceptedDecisionIds: readonly `ADR-${string}`[];
  readonly acceptedDecisionPaths: readonly string[];
}

export type AcceptedArchitectureDecisionReader = (input: {
  readonly baselinePath: string;
  readonly configPath: string;
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}) => Promise<AcceptedArchitectureDecisionEvidence>;

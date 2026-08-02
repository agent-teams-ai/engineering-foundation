export interface AcceptedDecisionEvidence {
  readonly acceptedDecisionIds: readonly `ADR-${string}`[];
  /** Immutable repository paths from the same validated governance baseline. */
  readonly acceptedDecisionPaths: readonly string[];
}

/**
 * Consumer-owned approval evidence. Architecture-decision governance owns
 * catalog, lifecycle, baseline, and digest validation before this capability
 * receives narrow stable IDs and historical paths.
 */
export interface AcceptedDecisionEvidencePort {
  readAcceptedDecisionEvidence(input: {
    readonly consumerRoot: string;
    readonly baselinePath: string;
    readonly governanceConfigPath: string;
    readonly signal?: AbortSignal;
  }): Promise<AcceptedDecisionEvidence>;
}

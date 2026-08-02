export interface AcceptedDecisionEvidence {
  readonly acceptedDecisionIds: readonly `ADR-${string}`[];
}

export interface ReadAcceptedDecisionEvidenceInput {
  readonly consumerRoot: string;
  readonly baselinePath: string;
  readonly governanceConfigPath: string;
  readonly signal?: AbortSignal;
}

/**
 * Consumer-owned view of accepted ADR evidence. The producer's baseline schema
 * is intentionally translated by an ACL rather than entering this feature's
 * policy model.
 */
export interface AcceptedDecisionEvidencePort {
  readAcceptedDecisionEvidence(
    input: ReadAcceptedDecisionEvidenceInput
  ): Promise<AcceptedDecisionEvidence>;
}

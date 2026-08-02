/**
 * Consumer-owned approval evidence. The governance feature owns its complete
 * ADR model; this capability only needs to know whether an immutable accepted
 * decision baseline attests to one configured decision path.
 */
export interface AcceptedDecisionEvidencePort {
  hasAcceptedDecision(input: {
    readonly consumerRoot: string;
    readonly decisionPath: string;
    readonly baselinePath: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean>;
}

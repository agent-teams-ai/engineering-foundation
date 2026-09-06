import type {
  AcceptedArchitectureDecisionReader,
  AcceptedDecisionEvidence,
  AcceptedDecisionEvidencePort
} from "../../../application/ports/accepted-decision-evidence.js";


/**
 * Anti-corruption layer for immutable architecture-decision governance. A
 * baseline row alone cannot authorize a breaking package API change: governance
 * validates the ADR catalog, lifecycle, document digest, and baseline first.
 */
export class GovernanceAcceptedDecisionEvidenceAcl
  implements AcceptedDecisionEvidencePort
{
  constructor(private readonly readAcceptedArchitectureDecisionEvidence: AcceptedArchitectureDecisionReader) {}

  async readAcceptedDecisionEvidence(input: {
    readonly consumerRoot: string;
    readonly baselinePath: string;
    readonly governanceConfigPath: string;
    readonly signal?: AbortSignal;
  }): Promise<AcceptedDecisionEvidence> {
    return this.readAcceptedArchitectureDecisionEvidence({
      consumerRoot: input.consumerRoot,
      baselinePath: input.baselinePath,
      configPath: input.governanceConfigPath,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  }
}

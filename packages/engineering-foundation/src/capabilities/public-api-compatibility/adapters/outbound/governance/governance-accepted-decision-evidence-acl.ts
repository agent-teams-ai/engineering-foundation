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

  async readAcceptedDecisionEvidence(input: Parameters<AcceptedDecisionEvidencePort["readAcceptedDecisionEvidence"]>[0]): Promise<AcceptedDecisionEvidence> {
    const evidence = await this.readAcceptedArchitectureDecisionEvidence({
      consumerRoot: input.consumerRoot,
      baselinePath: input.baselinePath,
      configPath: input.governanceConfigPath,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (input.growthDecisions === undefined) { return evidence; }
    // Retained governance proves IDs/paths, not an owner-approved exact SDK
    // transition. Never manufacture source/diff approval from those records.
    return { ...evidence, growthDecisionAuthority: { status: "unavailable", reasons: ["governance-exact-growth-owner-binding-unavailable"] } };
  }
}

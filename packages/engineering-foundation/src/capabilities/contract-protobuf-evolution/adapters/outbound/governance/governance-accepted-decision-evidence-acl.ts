import { readAcceptedArchitectureDecisionEvidence } from "../../../../governance-architecture-decisions/module.js";
import type {
  AcceptedDecisionEvidence,
  AcceptedDecisionEvidencePort,
  ReadAcceptedDecisionEvidenceInput
} from "../../../application/ports/accepted-decision-evidence.js";

/**
 * Anti-corruption layer for immutable architecture-decision governance. A
 * baseline ID alone is not evidence: governance validates the complete ADR
 * catalog, lifecycle, document digest, and baseline before this adapter maps
 * the result to the narrow Protobuf-owned port.
 */
export class GovernanceAcceptedDecisionEvidenceAcl
  implements AcceptedDecisionEvidencePort
{
  async readAcceptedDecisionEvidence(
    input: ReadAcceptedDecisionEvidenceInput
  ): Promise<AcceptedDecisionEvidence> {
    const evidence = await readAcceptedArchitectureDecisionEvidence({
      consumerRoot: input.consumerRoot,
      baselinePath: input.baselinePath,
      configPath: input.governanceConfigPath,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return Object.freeze({
      acceptedDecisionIds: evidence.acceptedDecisionIds
    });
  }
}

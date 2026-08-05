import { assertNotCancelled } from "../../../../strict-yaml.js";
import type {
  ProtobufEvolutionConfiguration,
  ProtobufEvolutionPolicy
} from "../model/protobuf-release-evidence.js";
import type { AcceptedDecisionEvidencePort } from "../ports/accepted-decision-evidence.js";
import type { BufBreakingQualificationEvidencePort } from "../ports/buf-breaking-qualification-evidence.js";

const NO_ACCEPTED_DECISION_IDS = Object.freeze([]) as readonly `ADR-${string}`[];

export interface ResolveProtobufEvolutionPolicyInput {
  readonly consumerRoot: string;
  readonly configuration: ProtobufEvolutionConfiguration;
  readonly signal?: AbortSignal;
}

export interface ResolveProtobufEvolutionPolicyDependencies {
  readonly acceptedDecisionEvidence: AcceptedDecisionEvidencePort;
  readonly bufBreakingQualificationEvidence: BufBreakingQualificationEvidencePort;
}

export async function resolveProtobufEvolutionPolicy(
  input: ResolveProtobufEvolutionPolicyInput,
  dependencies: ResolveProtobufEvolutionPolicyDependencies
): Promise<ProtobufEvolutionPolicy> {
  assertNotCancelled(input.signal);
  const baselinePath = input.configuration.acceptedDecisionBaselinePath;
  const governanceConfigPath = input.configuration.governanceConfigPath;
  let acceptedDecisionIds = NO_ACCEPTED_DECISION_IDS;
  if (baselinePath !== undefined) {
    if (governanceConfigPath === undefined) {
      throw new Error("Protobuf governance evidence configuration is internally inconsistent.");
    }
    acceptedDecisionIds = (
      await dependencies.acceptedDecisionEvidence.readAcceptedDecisionEvidence({
        consumerRoot: input.consumerRoot,
        baselinePath,
        governanceConfigPath,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      })
    ).acceptedDecisionIds;
  } else if (governanceConfigPath !== undefined) {
    throw new Error("Protobuf governance evidence configuration is internally inconsistent.");
  }
  const qualifiedBreakingEvidence =
    await dependencies.bufBreakingQualificationEvidence.read({
      consumerRoot: input.consumerRoot,
      configuration: input.configuration,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  assertNotCancelled(input.signal);
  return Object.freeze({
    acceptedDecisionIds,
    approvedBreakingChanges: input.configuration.approvedBreakingChanges,
    released: input.configuration.released,
    current: Object.freeze({
      ...input.configuration.current,
      breaking: qualifiedBreakingEvidence.breaking,
      releasedDescriptorImageDigest:
        qualifiedBreakingEvidence.releasedDescriptorImageDigest
    })
  });
}

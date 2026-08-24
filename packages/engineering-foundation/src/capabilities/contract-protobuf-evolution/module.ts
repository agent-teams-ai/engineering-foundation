import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { GovernanceAcceptedDecisionEvidenceAcl } from "./adapters/outbound/governance/governance-accepted-decision-evidence-acl.js";
import { FilesystemBufBreakingQualificationEvidence } from "./adapters/outbound/qualification/filesystem-buf-breaking-qualification-evidence.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";
import { evaluateProtobufEvolution } from "./application/policies/evaluate-protobuf-evolution.js";
import type { AcceptedDecisionEvidencePort } from "./application/ports/accepted-decision-evidence.js";
import type { BufBreakingQualificationEvidencePort } from "./application/ports/buf-breaking-qualification-evidence.js";
import { resolveProtobufEvolutionPolicy } from "./application/use-cases/resolve-protobuf-evolution-policy.js";

export {
  evaluateProtobufEvolution
} from "./application/policies/evaluate-protobuf-evolution.js";
export type {
  ApprovedProtobufBreakingChange,
  BufBreakingEvidence,
  BufBreakingFinding,
  BufBreakingQualificationBinding,
  BufBreakingQualificationEvidence,
  BufGeneratorVersionEvidence,
  CurrentProtobufContractDeclaration,
  CurrentProtobufContractEvidence,
  GenerationDriftEvidence,
  ProtobufEvolutionPolicy,
  ReleasedProtobufContractEvidence,
  Sha256Digest
} from "./application/model/protobuf-release-evidence.js";
export type {
  AcceptedDecisionEvidence,
  AcceptedDecisionEvidencePort,
  ReadAcceptedDecisionEvidenceInput
} from "./application/ports/accepted-decision-evidence.js";
export {
  PROTOBUF_EVOLUTION_RULES,
  PROTOBUF_EVOLUTION_RULES_BY_ID
} from "./application/rules.js";

export interface ProtobufEvolutionCapabilityDependencies {
  readonly acceptedDecisionEvidence?: AcceptedDecisionEvidencePort;
  readonly bufBreakingQualificationEvidence?: BufBreakingQualificationEvidencePort;
}

export function createProtobufEvolutionCapability(
  dependencies: ProtobufEvolutionCapabilityDependencies = {}
): CapabilityDefinition {
  const acceptedDecisionEvidence =
    dependencies.acceptedDecisionEvidence ?? new GovernanceAcceptedDecisionEvidenceAcl();
  const bufBreakingQualificationEvidence =
    dependencies.bufBreakingQualificationEvidence ??
    new FilesystemBufBreakingQualificationEvidence();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const configuration = await loadCapabilityConfig(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        const policy = await resolveProtobufEvolutionPolicy(
          {
            consumerRoot: invocation.consumerRoot,
            configuration,
            ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
          },
          { acceptedDecisionEvidence, bufBreakingQualificationEvidence }
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: evaluateProtobufEvolution(policy)
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "protobuf-evolution-execution"
        });
      }
    }
  });
}

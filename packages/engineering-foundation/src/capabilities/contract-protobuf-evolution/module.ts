import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";
import { evaluateProtobufEvolution } from "./application/policies/evaluate-protobuf-evolution.js";

export {
  evaluateProtobufEvolution
} from "./application/policies/evaluate-protobuf-evolution.js";
export type {
  ApprovedProtobufBreakingChange,
  BufBreakingEvidence,
  BufGeneratorVersionEvidence,
  CurrentProtobufContractEvidence,
  GenerationDriftEvidence,
  ProtobufEvolutionPolicy,
  ReleasedProtobufContractEvidence,
  Sha256Digest
} from "./application/model/protobuf-release-evidence.js";
export {
  PROTOBUF_EVOLUTION_RULES,
  PROTOBUF_EVOLUTION_RULES_BY_ID
} from "./application/rules.js";

export function createProtobufEvolutionCapability(): CapabilityDefinition {
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: evaluateProtobufEvolution(policy)
        });
      } catch (error) {
        if (error instanceof CapabilityInputError) {
          return capabilityReport({
            capabilityId: CAPABILITY_ID,
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            outcome: error.problem.code === "EXECUTION_CANCELLED" ? "cancelled" : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Protobuf evolution capability execution failed.",
            phase: "protobuf-evolution-execution",
            retryable: false
          }
        });
      }
    }
  });
}

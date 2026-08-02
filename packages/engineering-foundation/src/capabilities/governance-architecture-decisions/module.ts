import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { FilesystemMarkdownRepository } from "../../documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { NodeArchitectureDecisionFingerprint } from "./adapters/outbound/crypto/node-architecture-decision-fingerprint.js";
import { FilesystemArchitectureDecisionBaselineRepository } from "./adapters/outbound/filesystem/filesystem-architecture-decision-baseline-repository.js";
import { ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID } from "./application/rules.js";
import { analyzeArchitectureDecisions } from "./application/use-cases/analyze-architecture-decisions.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";

export { ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID };

export function createArchitectureDecisionGovernanceCapability(): CapabilityDefinition {
  const dependencies = Object.freeze({
    baselineRepository: new FilesystemArchitectureDecisionBaselineRepository(),
    fingerprint: new NodeArchitectureDecisionFingerprint(),
    markdownRepository: new FilesystemMarkdownRepository()
  });
  return Object.freeze({
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    id: CAPABILITY_ID,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          capabilityId: CAPABILITY_ID,
          diagnostics: await analyzeArchitectureDecisions(
            {
              consumerRoot: invocation.consumerRoot,
              policy,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            dependencies
          )
        });
      } catch (error) {
        if (error instanceof CapabilityInputError) {
          return capabilityReport({
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            capabilityId: CAPABILITY_ID,
            outcome:
              error.problem.code === "EXECUTION_CANCELLED" ? "cancelled" : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          capabilityId: CAPABILITY_ID,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Architecture decision governance capability execution failed.",
            phase: "architecture-decision-governance-execution",
            retryable: false
          }
        });
      }
    }
  });
}

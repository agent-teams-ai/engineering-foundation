import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { FilesystemRepositoryAgentWorkflowReader } from "./adapters/outbound/filesystem/filesystem-repository-agent-workflow-reader.js";
import { REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID } from "./application/rules.js";
import { analyzeRepositoryAgentWorkflow } from "./application/use-cases/analyze-repository-agent-workflow.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadAgentWorkflowPolicy
} from "./contract/config.js";

export { REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID };

export function createRepositoryAgentWorkflowCapability(): CapabilityDefinition {
  const reader = new FilesystemRepositoryAgentWorkflowReader();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadAgentWorkflowPolicy(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: await analyzeRepositoryAgentWorkflow(
            {
              consumerRoot: invocation.consumerRoot,
              policy,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            reader
          )
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
            message: "Repository agent workflow capability execution failed.",
            phase: "repository-agent-workflow-execution",
            retryable: false
          }
        });
      }
    }
  });
}

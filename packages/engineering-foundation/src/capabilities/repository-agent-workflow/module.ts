import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { FilesystemRepositoryAgentWorkflowReader } from "./adapters/outbound/filesystem/filesystem-repository-agent-workflow-reader.js";
import { REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID } from "./application/rules.js";
import { analyzeRepositoryAgentWorkflow } from "./application/use-cases/analyze-repository-agent-workflow.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";

import { loadVersionedAgentWorkflowPolicy, type VersionedWorkflowDependencies } from "./adapters/inbound/configuration/load-versioned-agent-workflow-policy.js";
import { evaluateRepositoryAgentWorkflowV2, workflowV2ConformancePolicy } from "./application/policies/evaluate-repository-agent-workflow.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

export { REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID };

export function createRepositoryAgentWorkflowCapability(input: {
  readonly assertSchema: VersionedWorkflowDependencies["assertSchema"];
}): CapabilityDefinition {
  const reader = new FilesystemRepositoryAgentWorkflowReader();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      let configVersion: 1 | 2 = CAPABILITY_CONFIG_SCHEMA_VERSION;
      try {
        const loaded = await loadVersionedAgentWorkflowPolicy(
          {
            readYaml: async (...args) => {
              const value = await loadStrictYamlFile(...args);
              if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 2) {
                configVersion = 2;
              }
              return value;
            },
            assertSchema: input.assertSchema
          },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: loaded.version,
          diagnostics: loaded.version === 2
            ? evaluateRepositoryAgentWorkflowV2(loaded.policy, await reader.read(
              invocation.consumerRoot, workflowV2ConformancePolicy(loaded.policy), invocation.signal
            ))
            : await analyzeRepositoryAgentWorkflow(
            {
              consumerRoot: invocation.consumerRoot,
              policy: loaded.policy,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            reader
          )
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: configVersion,
          error,
          phase: "repository-agent-workflow-execution"
        });
      }
    }
  });
}

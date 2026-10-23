import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation,
} from "../../features/validation-reporting/api.js";
import { FilesystemRepositoryAgentWorkflowReader } from "./adapters/outbound/filesystem/filesystem-repository-agent-workflow-reader.js";
import { REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID } from "./application/rules.js";
import { CAPABILITY_CONFIG_SCHEMA_VERSION, CAPABILITY_ID } from "./contract/config.js";

import {
  agentWorkflowConfigVersion,
  loadVersionedAgentWorkflowPolicy,
  type VersionedWorkflowDependencies,
} from "./adapters/inbound/configuration/load-versioned-agent-workflow-policy.js";
import {
  analyzeRepositoryAgentWorkflow,
  analyzeRepositoryAgentWorkflowV2,
} from "./application/use-cases/analyze-repository-agent-workflow.js";
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
              configVersion = agentWorkflowConfigVersion(value);
              return value;
            },
            assertSchema: input.assertSchema,
          },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal,
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: loaded.version,
          diagnostics:
            loaded.kind === "coverage"
              ? await analyzeRepositoryAgentWorkflowV2(
                  {
                    consumerRoot: invocation.consumerRoot,
                    policy: loaded.policy,
                    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
                  },
                  reader,
                )
              : await analyzeRepositoryAgentWorkflow(
                  {
                    consumerRoot: invocation.consumerRoot,
                    policy: loaded.policy,
                    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
                  },
                  reader,
                ),
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: configVersion,
          error,
          phase: "repository-agent-workflow-execution",
        });
      }
    },
  });
}

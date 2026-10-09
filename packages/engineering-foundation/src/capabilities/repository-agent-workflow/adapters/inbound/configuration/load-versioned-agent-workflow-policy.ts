import { parseAgentWorkflowPolicy } from "./parse-agent-workflow-policy.js";
import { parseAgentWorkflowPolicyV2 } from "./parse-agent-workflow-policy-v2.js";
import type { AgentWorkflowV2ConfigurationDependencies } from "./load-agent-workflow-policy-v2.js";
import type { RepositoryAgentWorkflowPolicy } from "../../../application/model/repository-agent-workflow.js";
import type { WorkflowCoveragePolicy } from "../../../application/model/check-changed.js";

export interface VersionedWorkflowDependencies {
  readonly readYaml: AgentWorkflowV2ConfigurationDependencies["readYaml"];
  readonly assertSchema: (id: "repository-agent-workflow/v1" | "repository-agent-workflow/v2", value: unknown, phase: string) => Promise<void>;
}
export async function loadVersionedAgentWorkflowPolicy(dependencies: VersionedWorkflowDependencies, root: string, path: string, signal?: AbortSignal): Promise<{ readonly version: 1; readonly policy: RepositoryAgentWorkflowPolicy } | { readonly version: 2; readonly policy: WorkflowCoveragePolicy }> {
  const value = await dependencies.readYaml(root, path, "repository-agent-workflow-config", signal);
  if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 1) {
    await dependencies.assertSchema("repository-agent-workflow/v1", value, "repository-agent-workflow-config");
    return { version: 1, policy: parseAgentWorkflowPolicy(value, path) };
  }
  const policy = parseAgentWorkflowPolicyV2(value);
  await dependencies.assertSchema("repository-agent-workflow/v2", value, "repository-agent-workflow-config");
  return { version: 2, policy };
}

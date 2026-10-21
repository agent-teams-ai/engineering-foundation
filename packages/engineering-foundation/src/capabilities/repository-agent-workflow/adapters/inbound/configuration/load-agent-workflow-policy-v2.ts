import type { WorkflowCoveragePolicy } from "../../../application/model/check-changed.js";
import { parseAgentWorkflowPolicyV2 } from "./parse-agent-workflow-policy-v2.js";

export interface AgentWorkflowV2ConfigurationDependencies {
  readonly readYaml: (root: string, path: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (id: "repository-agent-workflow/v2", value: unknown, phase: string) => Promise<void>;
}
export async function loadAgentWorkflowPolicyV2(dependencies: AgentWorkflowV2ConfigurationDependencies, root: string, path: string, signal?: AbortSignal): Promise<WorkflowCoveragePolicy> {
  const value = await dependencies.readYaml(root, path, "repository-agent-workflow-config", signal);
  // Migration rejection precedes schema validation, and all executable effects.
  const policy = parseAgentWorkflowPolicyV2(value);
  await dependencies.assertSchema("repository-agent-workflow/v2", value, "repository-agent-workflow-config");
  return policy;
}

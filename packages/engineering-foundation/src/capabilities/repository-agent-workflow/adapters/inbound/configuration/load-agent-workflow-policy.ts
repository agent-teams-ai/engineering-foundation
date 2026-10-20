import type { RepositoryAgentWorkflowPolicy } from "../../../application/model/repository-agent-workflow.js";
import { parseAgentWorkflowPolicy } from "./parse-agent-workflow-policy.js";

export interface AgentWorkflowConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "repository-agent-workflow/v1" | "repository-agent-workflow/v2", input: unknown, phase: string) => Promise<void>;
}

export async function loadAgentWorkflowPolicy(
  dependencies: AgentWorkflowConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<RepositoryAgentWorkflowPolicy> {
  const input = await dependencies.readYaml(
    consumerRoot, configPath, "repository-agent-workflow-config", signal
  );
  const version = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)["schemaVersion"]
    : undefined;
  await dependencies.assertSchema(
    version === 2 ? "repository-agent-workflow/v2" : "repository-agent-workflow/v1",
    input,
    "repository-agent-workflow-config"
  );
  return parseAgentWorkflowPolicy(input, configPath);
}

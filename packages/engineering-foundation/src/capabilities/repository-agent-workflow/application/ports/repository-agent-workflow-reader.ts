import type {
  RepositoryAgentWorkflowEvidence,
  RepositoryAgentWorkflowPolicy
} from "../model/repository-agent-workflow.js";

export interface RepositoryAgentWorkflowReader {
  read(
    consumerRoot: string,
    policy: RepositoryAgentWorkflowPolicy,
    signal?: AbortSignal
  ): Promise<RepositoryAgentWorkflowEvidence>;
}

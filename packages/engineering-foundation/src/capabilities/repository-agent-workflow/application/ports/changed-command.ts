import type { RepositoryAgentWorkflowPolicy } from "../model/repository-agent-workflow.js";
import type { PackageScriptRunner, RepositoryChangesReader } from "./changed-workflow.js";

export interface AgentWorkflowChangedDependencies {
  readonly changesReader: RepositoryChangesReader;
  readonly scriptRunner: PackageScriptRunner;
  readonly loadPolicy: (consumerRoot: string, configPath: string, signal?: AbortSignal) => Promise<RepositoryAgentWorkflowPolicy>;
}

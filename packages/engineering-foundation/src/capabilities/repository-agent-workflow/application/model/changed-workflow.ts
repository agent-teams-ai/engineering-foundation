import type { RepositoryAgentWorkflowPolicy } from "./repository-agent-workflow.js";

export interface RepositoryChanges {
  readonly baselineRef: string;
  readonly baselineCommit: string | null;
  readonly changedPaths: readonly string[];
  readonly existingPaths: readonly string[];
}

export interface ScriptExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AgentWorkflowStepReport {
  readonly id: string;
  readonly script: string;
  readonly paths: readonly string[];
  readonly outcome: "passed" | "violations";
  readonly output: string;
}

export interface AgentWorkflowChangedReport {
  readonly reportSchemaVersion: 1;
  readonly outcome: "passed" | "violations";
  readonly coverage: "changed" | "fast-full";
  readonly baselineRef: string;
  readonly baselineCommit: string | null;
  readonly changedPaths: readonly string[];
  readonly steps: readonly AgentWorkflowStepReport[];
}

export interface AgentWorkflowInvocation {
  readonly consumerRoot: string;
  readonly policy: RepositoryAgentWorkflowPolicy;
  readonly baseRef?: string;
  readonly signal?: AbortSignal;
}

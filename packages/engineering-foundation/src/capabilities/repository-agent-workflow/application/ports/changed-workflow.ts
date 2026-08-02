import type {
  RepositoryChanges,
  ScriptExecutionResult
} from "../model/changed-workflow.js";

export interface RepositoryChangesReader {
  collect(input: {
    readonly consumerRoot: string;
    readonly baseRef?: string;
    readonly signal?: AbortSignal;
  }): Promise<RepositoryChanges>;
}

export interface PackageScriptRunner {
  run(input: {
    readonly consumerRoot: string;
    readonly script: string;
    readonly paths: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<ScriptExecutionResult>;
}

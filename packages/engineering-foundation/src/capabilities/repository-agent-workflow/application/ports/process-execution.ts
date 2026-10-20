import type { ManagedProcessExecutor } from "../../../../process-execution/api.js";

export type WorkflowProcessExecutor = ManagedProcessExecutor;
export interface ProcessExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type ExecuteWorkflowProcess = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly signal?: AbortSignal; readonly strictUtf8?: boolean;
    /** Overrides the supplied workflow environment; undefined removes a native variable name. */
    readonly environment?: Readonly<Record<string, string | undefined>> }
) => Promise<ProcessExecution>;

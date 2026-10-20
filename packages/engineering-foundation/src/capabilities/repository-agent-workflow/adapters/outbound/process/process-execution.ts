import type {
  ExecuteWorkflowProcess,
  WorkflowProcessExecutor,
  ProcessExecution
} from "../../../application/ports/process-execution.js";

export function createProcessExecution(executor: WorkflowProcessExecutor): ExecuteWorkflowProcess {
  return async function execute(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly signal?: AbortSignal;
      readonly strictUtf8?: boolean;
      readonly environment?: Readonly<Record<string, string | undefined>>;
    }
  ): Promise<ProcessExecution> {
    const result = await executor.run({
      args,
      command,
      cwd: options.cwd,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.strictUtf8 === undefined ? {} : { strictUtf8: options.strictUtf8 })
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout
    };
  };
}

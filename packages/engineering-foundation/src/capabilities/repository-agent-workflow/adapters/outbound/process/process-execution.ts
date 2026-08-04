import { executeManagedProcess } from "../../../../../process-execution/node-process-runner.js";

export interface ProcessExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function execute(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly signal?: AbortSignal;
  }
): Promise<ProcessExecution> {
  const result = await executeManagedProcess({
    args,
    command,
    cwd: options.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

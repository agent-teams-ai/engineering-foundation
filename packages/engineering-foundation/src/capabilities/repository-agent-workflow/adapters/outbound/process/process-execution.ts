import type {
  ExecuteWorkflowProcess,
  WorkflowProcessExecutor,
  ProcessExecution,
} from "../../../application/ports/process-execution.js";

export function createProcessExecution(
  executor: WorkflowProcessExecutor,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): ExecuteWorkflowProcess {
  return async function execute(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly signal?: AbortSignal;
      readonly strictUtf8?: boolean;
      readonly environment?: Readonly<Record<string, string | undefined>>;
    },
  ): Promise<ProcessExecution> {
    const inherited = new Map<string, readonly [string, string]>();
    for (const layer of [environment, options.environment]) {
      for (const [name, value] of Object.entries(layer ?? {})) {
        const identity = platform === "win32" ? name.toUpperCase() : name;
        if (value === undefined) {
          inherited.delete(identity);
        } else {
          inherited.set(identity, [name, value]);
        }
      }
    }
    const result = await executor.run({
      args,
      command,
      cwd: options.cwd,
      environment: Object.fromEntries(inherited.values()),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.strictUtf8 === undefined ? {} : { strictUtf8: options.strictUtf8 }),
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  };
}

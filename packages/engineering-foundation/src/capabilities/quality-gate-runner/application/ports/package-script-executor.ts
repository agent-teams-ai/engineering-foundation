interface PackageScriptExecution {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PackageScriptExecutor {
  run(input: {
    readonly consumerRoot: string;
    readonly scriptId: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<PackageScriptExecution>;
}

export class PackageScriptTimeoutError extends Error {
  constructor(readonly timeoutMs: number, options?: ErrorOptions) {
    super(`Package script timed out after ${timeoutMs}ms.`, options);
    this.name = "PackageScriptTimeoutError";
  }
}

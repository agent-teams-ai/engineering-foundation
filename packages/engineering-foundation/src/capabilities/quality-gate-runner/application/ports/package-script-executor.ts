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

/**
 * The package-script containment boundary accepted cancellation and proved
 * that its managed process tree has stopped.
 */
export class PackageScriptCancellationError extends Error {
  constructor(options?: ErrorOptions) {
    super("Package script was cancelled after containment completed.", options);
    this.name = "PackageScriptCancellationError";
  }
}

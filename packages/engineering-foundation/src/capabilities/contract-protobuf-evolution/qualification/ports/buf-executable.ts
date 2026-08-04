export interface BufInvocation {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly arguments: readonly string[];
}

export interface BufExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BufExecutable {
  run(
    invocation: BufInvocation,
    signal?: AbortSignal
  ): Promise<BufExecutionResult>;
}

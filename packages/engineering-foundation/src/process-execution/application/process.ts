export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Optional maximum wall-clock duration. Omission preserves unbounded behavior. */
  readonly timeoutMs?: number;
  /** Cancels the process and descendants retained by the platform containment boundary. */
  readonly signal?: AbortSignal;
}

export interface ManagedProcessResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export interface ManagedProcessRequest extends ProcessRequest {
  /** Reject malformed UTF-8 evidence rather than replacing bytes. */
  readonly strictUtf8?: boolean;
  /** Exact inherited environment; omission retains the platform adapter's inheritance. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export interface ManagedProcessExecutor {
  run(request: ManagedProcessRequest): Promise<ManagedProcessResult>;
}

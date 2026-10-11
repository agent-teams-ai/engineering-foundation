/** Private producer observations, never a public error payload or message parser. */
export interface ProcessFailureFacts {
  readonly reason: "launch" | "exit" | "timeout" | "cancelled" | "output-limit" | "invalid-output" | "stream" | "cleanup";
  readonly exitCode?: number;
  readonly signal?: ProcessSignal;
  readonly timeoutMs?: number;
}

const observations = new WeakMap<object, Readonly<ProcessFailureFacts>>();
const reasons = new Set(["launch", "exit", "timeout", "cancelled", "output-limit", "invalid-output", "stream", "cleanup"]);
// Portable owned signal vocabulary; arbitrary Node/provider strings are omitted.
const signalNames = [
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP",
  "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGSTOP",
  "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUSR1", "SIGUSR2",
  "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK"
] as const;
type ProcessSignal = (typeof signalNames)[number];
const signals = new Set<string>(signalNames);

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validMetadata(reason: string, exitCode: unknown, signal: unknown, timeoutMs: unknown): boolean {
  return (exitCode === undefined || (reason === "exit" && boundedInteger(exitCode, 0, 4_294_967_295))) &&
    (signal === undefined || (reason === "exit" && typeof signal === "string" && signals.has(signal))) &&
    (timeoutMs === undefined || (reason === "timeout" && boundedInteger(timeoutMs, 1, 2_147_483_647)));
}

/** Snapshot only own data properties. Malformed observations do not acquire identity. */
export function associateProcessFailureFacts(error: object, input: unknown): void {
  try {
    if (typeof input !== "object" || input === null || observations.has(error)) {
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some((key) =>
      typeof key !== "string" || !["reason", "exitCode", "signal", "timeoutMs"].includes(key) ||
      !Object.hasOwn(descriptors[key]!, "value"))) {
      return;
    }
    const reason: unknown = Object.hasOwn(descriptors, "reason") ? descriptors.reason?.value : undefined;
    const exitCode: unknown = Object.hasOwn(descriptors, "exitCode") ? descriptors.exitCode?.value : undefined;
    const signal: unknown = Object.hasOwn(descriptors, "signal") ? descriptors.signal?.value : undefined;
    const timeoutMs: unknown = Object.hasOwn(descriptors, "timeoutMs") ? descriptors.timeoutMs?.value : undefined;
    if (typeof reason !== "string" || !reasons.has(reason) ||
      !validMetadata(reason, exitCode, signal, timeoutMs)) {
      return;
    }
    observations.set(error, Object.freeze({
      __proto__: null,
      reason: reason as ProcessFailureFacts["reason"],
      ...(typeof exitCode === "number" ? { exitCode } : {}),
      ...(typeof signal === "string" ? { signal: signal as ProcessSignal } : {}),
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {})
    }));
  } catch {
    // Hostile reflection must not replace the original failure.
  }
}

export function readProcessFailureFacts(error: unknown): Readonly<ProcessFailureFacts> | undefined {
  return typeof error === "object" && error !== null ? observations.get(error) : undefined;
}

const wording: Readonly<Record<ProcessFailureFacts["reason"], string>> = {
  launch: "The process could not be started.",
  exit: "The process exited unsuccessfully.",
  timeout: "The process timed out.",
  cancelled: "The process was cancelled.",
  "output-limit": "Process output exceeded the capture limit.",
  "invalid-output": "Process output was not valid UTF-8.",
  stream: "A process output stream failed.",
  cleanup: "Process cleanup failed."
};

export function processFailureMessage(error: unknown): string {
  const facts = readProcessFailureFacts(error);
  if (facts === undefined) {
    return "An unexpected process failure occurred.";
  }
  return wording[facts.reason] +
    (facts.exitCode === undefined ? "" : ` Observed exit code: ${String(facts.exitCode)}.`) +
    (facts.signal === undefined ? "" : ` Observed signal: ${facts.signal}.`) +
    (facts.timeoutMs === undefined ? "" : ` Timeout: ${String(facts.timeoutMs)}ms.`);
}

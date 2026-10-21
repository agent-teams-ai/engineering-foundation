export type Engine = "tsrs" | "bun" | "typescript";

export type AttemptOutcome =
  | { readonly kind: "passed" }
  | { readonly kind: "diagnostics"; readonly output: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "engine-failure"; readonly reason: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unclassified"; readonly reason: string };

export interface AttemptResult {
  readonly outcome: AttemptOutcome;
  readonly captureComplete: boolean;
  readonly cleanupComplete: boolean;
  /** Diagnostics observed before a crash or timeout remain terminal. */
  readonly diagnostics: readonly string[];
}

export interface AttemptInput {
  readonly engine: Engine;
  readonly projects: readonly string[];
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface TypecheckDependencies {
  /** Runs the entire ordered project group, stopping on its first failure. */
  readonly run: (input: AttemptInput) => Promise<AttemptResult>;
  /** Monotonic milliseconds, using the same clock as deadlines. */
  readonly now: () => number;
}

export interface AttemptRecord {
  readonly engine: Engine;
  readonly result: AttemptResult;
  readonly durationMs: number;
}

export type TypecheckResult = {
  readonly status: "passed" | "passed-with-fallback";
  readonly engine: Engine;
  readonly attempts: readonly AttemptRecord[];
} | {
  readonly status: "failed";
  readonly code: "TOOLCHAIN_DIAGNOSTICS" | "TOOLCHAIN_CAPTURE_FAILURE"
    | "TOOLCHAIN_CLEANUP_FAILURE" | "TOOLCHAIN_CANCELLED"
    | "TOOLCHAIN_DEADLINE" | "TOOLCHAIN_UNCLASSIFIED_FAILURE"
    | "TOOLCHAIN_ALL_ENGINES_FAILED";
  readonly attempts: readonly AttemptRecord[];
};

const engines: readonly Engine[] = ["tsrs", "bun", "typescript"];
type FailureCode = Extract<TypecheckResult, { status: "failed" }>["code"];

function terminalFailure(result: AttemptResult, signal: AbortSignal, now: number, deadline: number): FailureCode | undefined {
  if (!result.captureComplete) { return "TOOLCHAIN_CAPTURE_FAILURE"; }
  if (!result.cleanupComplete) { return "TOOLCHAIN_CLEANUP_FAILURE"; }
  if (result.diagnostics.length > 0 || result.outcome.kind === "diagnostics") { return "TOOLCHAIN_DIAGNOSTICS"; }
  if (signal.aborted || result.outcome.kind === "cancelled") { return "TOOLCHAIN_CANCELLED"; }
  if (now >= deadline) { return "TOOLCHAIN_DEADLINE"; }
  return undefined;
}

export async function typecheck(input: {
  readonly projects: readonly string[];
  readonly signal: AbortSignal;
  readonly budgetMs?: number;
  readonly attemptBudgetMs?: number;
}, dependencies: TypecheckDependencies): Promise<TypecheckResult> {
  const budget = input.budgetMs ?? 300_000;
  const attemptBudget = input.attemptBudgetMs ?? 100_000;
  if (![budget, attemptBudget].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("TOOLCHAIN_INVALID_BUDGET");
  }
  if (input.projects.length === 0 || input.projects.some(path => path.trim().length === 0)
    || new Set(input.projects).size !== input.projects.length) {
    throw new Error("TOOLCHAIN_INVALID_PROJECTS");
  }
  const projects = Object.freeze([...input.projects]);
  const deadline = dependencies.now() + budget;
  const attempts: AttemptRecord[] = [];
  const failed = (code: Extract<TypecheckResult, { status: "failed" }>["code"]): TypecheckResult =>
    ({ status: "failed", code, attempts: Object.freeze([...attempts]) });

  for (const engine of engines) {
    if (input.signal.aborted) {return failed("TOOLCHAIN_CANCELLED");}
    const started = dependencies.now();
    if (started >= deadline) {return failed("TOOLCHAIN_DEADLINE");}
    // The adapter must settle owned execution and capture before returning.
    // An unexpected exception is terminal; it is never guessed to be retryable.
    let result: AttemptResult;
    try {
      result = await dependencies.run({ engine, projects, signal: input.signal,
        deadline: Math.min(deadline, started + attemptBudget) });
    } catch {
      return failed("TOOLCHAIN_UNCLASSIFIED_FAILURE");
    }
    attempts.push({ engine, result, durationMs: Math.max(0, dependencies.now() - started) });
    const terminal = terminalFailure(result, input.signal, dependencies.now(), deadline);
    if (terminal !== undefined) { return failed(terminal); }
    switch (result.outcome.kind) {
      case "passed":
        return { status: attempts.length === 1 ? "passed" : "passed-with-fallback",
          engine, attempts: Object.freeze([...attempts]) };
      case "diagnostics": return failed("TOOLCHAIN_DIAGNOSTICS");
      case "cancelled": return failed("TOOLCHAIN_CANCELLED");
      case "unclassified": return failed("TOOLCHAIN_UNCLASSIFIED_FAILURE");
      case "unavailable":
      case "engine-failure":
      case "timeout": break;
    }
  }
  return failed("TOOLCHAIN_ALL_ENGINES_FAILED");
}

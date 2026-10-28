import { devNull } from "node:os";
import { createProcessExecutor, isProcessRuntimeError } from "node-or-bun";
import { createNodeProcessAdapter } from "node-or-bun/node";
import type { ProcessRunResult, ProcessRuntimeError } from "node-or-bun";
import type { AttemptInput, AttemptResult, Engine } from "../application/typecheck.js";

export interface CheckerExecutable {
  readonly command: string;
  readonly prefix: readonly string[];
  readonly cwd?: string;
}

export type CheckerExecutables = Readonly<Record<Engine, CheckerExecutable | null>>;

export function assertCompleteProcessResult(result: ProcessRunResult): void {
  if (
    !result.facts.outputBounded ||
    result.facts.incompleteCustody ||
    result.facts.lateFailureCodes.length > 0
  ) {
    throw new Error("TOOLCHAIN_INCOMPLETE_PROCESS_RESULT");
  }
}

function diagnostics(output: string): readonly string[] {
  // All three qualified pins use non-pretty TypeScript diagnostic records.
  // Unknown formats remain failures rather than being guessed to be crashes.
  return output
    .split(/\r?\n/u)
    .filter((line) => /^(?:.+\(\d+,\d+\): )?error TS\d{4,5}: /u.test(line));
}

const failure = (reason: string): AttemptResult => ({
  outcome: { kind: "unclassified", reason },
  captureComplete: false,
  cleanupComplete: false,
  diagnostics: [],
});

function observeResult(result: ProcessRunResult): AttemptResult | null {
  const output = `${result.stdout}\n${result.stderr}`;
  const records = diagnostics(output);
  const captureComplete =
    result.facts.outputBounded &&
    !result.facts.lateFailureCodes.some((code) =>
      ["stream", "output-limit", "invalid-output"].includes(code),
    );
  const cleanupComplete =
    !result.facts.incompleteCustody && !result.facts.lateFailureCodes.includes("cleanup");
  if (records.length === 0 && result.exitCode === 0 && captureComplete && cleanupComplete) {
    return null;
  }
  return {
    outcome:
      records.length > 0
        ? { kind: "diagnostics", output }
        : result.signal === "SIGABRT" || result.signal === "SIGSEGV"
          ? { kind: "engine-failure", reason: `native-crash:${result.signal}` }
          : {
              kind: "unclassified",
              reason: `exit:${String(result.exitCode)};signal:${String(result.signal)}`,
            },
    captureComplete,
    cleanupComplete,
    diagnostics: records,
  };
}

function observeFailure(error: ProcessRuntimeError): AttemptResult {
  return {
    outcome:
      error.code === "timeout"
        ? { kind: "timeout" }
        : error.code === "cancelled"
          ? { kind: "cancelled" }
          : { kind: "unclassified", reason: `process:${error.code}` },
    captureComplete:
      error.output !== null &&
      error.facts.outputBounded &&
      ![error.code, ...error.facts.lateFailureCodes].some((code) =>
        ["stream", "output-limit", "invalid-output"].includes(code),
      ),
    cleanupComplete:
      !error.incompleteCustody &&
      error.code !== "cleanup" &&
      !error.facts.lateFailureCodes.includes("cleanup"),
    diagnostics:
      error.output === null ? [] : diagnostics(`${error.output.stdout}\n${error.output.stderr}`),
  };
}

export function createCheckerRunner(input: {
  readonly cwd: string;
  readonly executables: CheckerExecutables;
  readonly now: () => number;
}): (attempt: AttemptInput) => Promise<AttemptResult> {
  const executor = createProcessExecutor(createNodeProcessAdapter());
  return async (attempt) => {
    const executable = input.executables[attempt.engine];
    if (executable === null) {
      return {
        outcome: { kind: "unavailable", reason: "no-qualified-platform-binary" },
        captureComplete: true,
        cleanupComplete: true,
        diagnostics: [],
      };
    }
    for (const project of attempt.projects) {
      const remaining = Math.floor(attempt.deadline - input.now());
      if (remaining <= 0) {
        return {
          outcome: { kind: "timeout" },
          captureComplete: true,
          cleanupComplete: true,
          diagnostics: [],
        };
      }
      const flags =
        attempt.engine === "bun"
          ? [
              "check",
              "--no-pretty",
              "--incremental",
              "true",
              "--tsBuildInfoFile",
              devNull,
              "-p",
              project,
            ]
          : [
              "--noEmit",
              "--incremental",
              "true",
              "--tsBuildInfoFile",
              devNull,
              "--pretty",
              "false",
              "-p",
              project,
            ];
      try {
        const result = await executor.run({
          command: executable.command,
          args: [...executable.prefix, ...flags],
          cwd: executable.cwd ?? input.cwd,
          signal: attempt.signal,
          timeoutMs: remaining,
          strictUtf8: true,
        });
        const observed = observeResult(result);
        if (observed !== null) {
          return observed;
        }
      } catch (error) {
        if (!isProcessRuntimeError(error)) {
          return failure("unexpected-process-error");
        }
        return observeFailure(error);
      }
    }
    return {
      outcome: { kind: "passed" },
      captureComplete: true,
      cleanupComplete: true,
      diagnostics: [],
    };
  };
}

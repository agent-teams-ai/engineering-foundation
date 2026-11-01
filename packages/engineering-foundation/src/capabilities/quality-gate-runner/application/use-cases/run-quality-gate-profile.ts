import type { NormalizedQualityGateProfile, QualityGateTask } from "../model/quality-gate.js";
import type { QualityGateRunReport, QualityGateTaskReport } from "../model/quality-gate-report.js";
import type { MonotonicClock } from "../ports/monotonic-clock.js";
import {
  PackageScriptCancellationError,
  PackageScriptTimeoutError,
  type PackageScriptExecutor,
} from "../ports/package-script-executor.js";

const FAILURE_TAIL_CHARACTERS = 8_192;

function unsafeTerminalControl(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function sanitizeFailureOutput(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += unsafeTerminalControl(codePoint)
      ? `\\u{${codePoint.toString(16).padStart(4, "0")}}`
      : character;
  }
  return sanitized;
}

function elapsed(clock: MonotonicClock, startedAt: number): number {
  return Math.max(0, Math.floor(clock.nowMs() - startedAt));
}

function failureTail(stdout: string, stderr: string): string {
  const combined = sanitizeFailureOutput(
    [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join("\n"),
  );
  const tail =
    combined.length <= FAILURE_TAIL_CHARACTERS
      ? combined
      : combined.slice(combined.length - FAILURE_TAIL_CHARACTERS);
  return /^[\udc00-\udfff]/u.test(tail) ? tail.slice(1) : tail;
}

async function executeTask(
  input: {
    readonly packageManager: "bun" | "pnpm";
    readonly consumerRoot: string;
    readonly task: QualityGateTask;
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
  },
  executor: PackageScriptExecutor,
  clock: MonotonicClock,
): Promise<QualityGateTaskReport> {
  const startedAt = clock.nowMs();
  try {
    const remaining =
      input.deadlineMs === undefined ? undefined : Math.floor(input.deadlineMs - clock.nowMs());
    if (remaining !== undefined && remaining <= 0) {
      return terminalReport(input.task.id, "timed-out");
    }
    const timeoutMs =
      remaining === undefined
        ? input.task.timeoutMs
        : Math.min(input.task.timeoutMs ?? remaining, remaining);
    const result = await executor.run({
      packageManager: input.packageManager,
      consumerRoot: input.consumerRoot,
      scriptId: input.task.id,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const durationMs = elapsed(clock, startedAt);
    return Object.freeze({
      id: input.task.id,
      outcome:
        input.deadlineMs !== undefined && clock.nowMs() >= input.deadlineMs
          ? "timed-out"
          : result.exitCode === 0
            ? "passed"
            : "failed",
      durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      failureTail: result.exitCode === 0 ? "" : failureTail(result.stdout, result.stderr),
    });
  } catch (error) {
    const cancelled = error instanceof PackageScriptCancellationError;
    const timedOut = error instanceof PackageScriptTimeoutError;
    return Object.freeze({
      id: input.task.id,
      outcome: cancelled ? "cancelled" : timedOut ? "timed-out" : "failed",
      durationMs: elapsed(clock, startedAt),
      exitCode: null,
      signal: null,
      failureTail: cancelled
        ? ""
        : error instanceof Error
          ? failureTail("", error.message)
          : "Package script execution failed.",
    });
  }
}

function terminalReport(
  id: string,
  outcome: "blocked" | "cancelled" | "timed-out",
): QualityGateTaskReport {
  return Object.freeze({
    id,
    outcome,
    durationMs: 0,
    exitCode: null,
    signal: null,
    failureTail: "",
  });
}

function profileOutcome(
  tasks: readonly QualityGateTaskReport[],
  signal: AbortSignal | undefined,
): QualityGateRunReport["outcome"] {
  if (tasks.some(({ outcome }) => outcome === "failed" || outcome === "timed-out")) {
    return "failed";
  }
  if (signal?.aborted === true || tasks.some(({ outcome }) => outcome === "cancelled")) {
    return "cancelled";
  }
  return tasks.every(({ outcome }) => outcome === "passed") ? "passed" : "failed";
}

export async function runQualityGateProfile(
  input: {
    readonly consumerRoot: string;
    readonly profile: NormalizedQualityGateProfile;
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
  },
  executor: PackageScriptExecutor,
  clock: MonotonicClock,
): Promise<QualityGateRunReport> {
  if (input.deadlineMs !== undefined && !Number.isFinite(input.deadlineMs)) {
    throw new TypeError("Aggregate gate deadline must be finite.");
  }
  const startedAt = clock.nowMs();
  const reports = new Map<string, QualityGateTaskReport>();
  const active = new Map<string, Promise<QualityGateTaskReport>>();

  while (reports.size < input.profile.tasks.length) {
    const madeProgress = scheduleReadyTasks(input, reports, active, executor, clock);

    if (active.size > 0) {
      const completed = await Promise.race(active.values());
      active.delete(completed.id);
      reports.set(completed.id, completed);
      continue;
    }
    if (!madeProgress && reports.size < input.profile.tasks.length) {
      throw new Error("Quality gate scheduler reached an invalid dependency state.");
    }
  }

  const tasks = Object.freeze(
    input.profile.tasks.map((task) => reports.get(task.id) as QualityGateTaskReport),
  );
  const durationMs = elapsed(clock, startedAt);
  const outcome = profileOutcome(tasks, input.signal);
  return Object.freeze({
    reportSchemaVersion: 1,
    profileId: input.profile.id,
    outcome:
      outcome === "passed" && input.deadlineMs !== undefined && clock.nowMs() >= input.deadlineMs
        ? "failed"
        : outcome,
    durationMs,
    tasks,
  });
}

function scheduleReadyTasks(
  input: {
    readonly consumerRoot: string;
    readonly profile: NormalizedQualityGateProfile;
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
  },
  reports: Map<string, QualityGateTaskReport>,
  active: Map<string, Promise<QualityGateTaskReport>>,
  executor: PackageScriptExecutor,
  clock: MonotonicClock,
): boolean {
  let madeProgress = false;
  for (const task of input.profile.tasks) {
    if (reports.has(task.id) || active.has(task.id)) {
      continue;
    }
    if (input.signal?.aborted === true) {
      reports.set(task.id, terminalReport(task.id, "cancelled"));
      madeProgress = true;
      continue;
    }
    if (input.deadlineMs !== undefined && clock.nowMs() >= input.deadlineMs) {
      reports.set(task.id, terminalReport(task.id, "timed-out"));
      madeProgress = true;
      continue;
    }
    const dependencies = [...task.needs, ...task.after].map((id) => reports.get(id));
    if (dependencies.some((report) => report === undefined)) {
      continue;
    }
    if (task.needs.some((id) => reports.get(id)?.outcome !== "passed")) {
      reports.set(task.id, terminalReport(task.id, "blocked"));
      madeProgress = true;
      continue;
    }
    if (active.size >= input.profile.concurrency) {
      break;
    }
    active.set(
      task.id,
      executeTask(
        {
          packageManager: input.profile.packageManager,
          consumerRoot: input.consumerRoot,
          task,
          ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        executor,
        clock,
      ),
    );
    madeProgress = true;
  }
  return madeProgress;
}

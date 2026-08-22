import type {
  QualityGateProfile,
  QualityGateTask
} from "../model/quality-gate.js";
import type {
  QualityGateRunReport,
  QualityGateTaskReport
} from "../model/quality-gate-report.js";
import type { MonotonicClock } from "../ports/monotonic-clock.js";
import {
  PackageScriptTimeoutError,
  type PackageScriptExecutor
} from "../ports/package-script-executor.js";

const FAILURE_TAIL_CHARACTERS = 8_192;

function elapsed(clock: MonotonicClock, startedAt: number): number {
  return Math.max(0, Math.floor(clock.nowMs() - startedAt));
}

function failureTail(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()]
    .filter((value) => value.length > 0)
    .join("\n");
  return combined.length <= FAILURE_TAIL_CHARACTERS
    ? combined
    : combined.slice(combined.length - FAILURE_TAIL_CHARACTERS);
}

async function executeTask(input: {
  readonly consumerRoot: string;
  readonly task: QualityGateTask;
  readonly signal?: AbortSignal;
}, executor: PackageScriptExecutor, clock: MonotonicClock): Promise<QualityGateTaskReport> {
  const startedAt = clock.nowMs();
  try {
    const result = await executor.run({
      consumerRoot: input.consumerRoot,
      scriptId: input.task.id,
      ...(input.task.timeoutMs === undefined
        ? {}
        : { timeoutMs: input.task.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return Object.freeze({
      id: input.task.id,
      outcome: result.exitCode === 0 ? "passed" : "failed",
      durationMs: elapsed(clock, startedAt),
      exitCode: result.exitCode,
      signal: result.signal,
      failureTail:
        result.exitCode === 0 ? "" : failureTail(result.stdout, result.stderr)
    });
  } catch (error) {
    const cancelled = input.signal?.aborted === true;
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
          ? error.message.slice(-FAILURE_TAIL_CHARACTERS)
          : "Package script execution failed."
    });
  }
}

function terminalReport(
  id: string,
  outcome: "blocked" | "cancelled"
): QualityGateTaskReport {
  return Object.freeze({
    id,
    outcome,
    durationMs: 0,
    exitCode: null,
    signal: null,
    failureTail: ""
  });
}

export async function runQualityGateProfile(input: {
  readonly consumerRoot: string;
  readonly profile: QualityGateProfile;
  readonly signal?: AbortSignal;
}, executor: PackageScriptExecutor, clock: MonotonicClock): Promise<QualityGateRunReport> {
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
    input.profile.tasks.map((task) => reports.get(task.id) as QualityGateTaskReport)
  );
  return Object.freeze({
    reportSchemaVersion: 1,
    profileId: input.profile.id,
    outcome: tasks.some(({ outcome }) => outcome === "cancelled")
      ? "cancelled"
      : tasks.every(({ outcome }) => outcome === "passed")
        ? "passed"
        : "failed",
    durationMs: elapsed(clock, startedAt),
    tasks
  });
}

function scheduleReadyTasks(
  input: {
    readonly consumerRoot: string;
    readonly profile: QualityGateProfile;
    readonly signal?: AbortSignal;
  },
  reports: Map<string, QualityGateTaskReport>,
  active: Map<string, Promise<QualityGateTaskReport>>,
  executor: PackageScriptExecutor,
  clock: MonotonicClock
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
    active.set(task.id, executeTask({
      consumerRoot: input.consumerRoot,
      task,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }, executor, clock));
    madeProgress = true;
  }
  return madeProgress;
}

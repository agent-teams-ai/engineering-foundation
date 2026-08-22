import { CapabilityInputError } from "../../capability-runtime.js";
import type { QualityGateRunReport } from "./application/model/quality-gate-report.js";
import { evaluateQualityGateScripts } from "./application/policies/evaluate-quality-gate-scripts.js";
import { runQualityGateProfile } from "./application/use-cases/run-quality-gate-profile.js";
import { renderQualityGateRunReport } from "./adapters/inbound/cli/report-renderer.js";
import { FilesystemPackageScriptCatalogReader } from "./adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import {
  PnpmQualityGateScriptExecutor,
  type QualityGatePnpmEnvironment
} from "./adapters/outbound/pnpm/pnpm-package-script-executor.js";
import { performanceMonotonicClock } from "./adapters/outbound/time/performance-monotonic-clock.js";
import { loadQualityGatePolicy } from "./contract/config.js";

const ACTIVE_GATE_ENVIRONMENT_VARIABLE =
  "AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE";

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "quality-gate-runner-command",
    retryable: false
  });
}

function exitCodeForQualityGateRun(
  report: QualityGateRunReport,
  cancellationSignal?: "SIGINT" | "SIGTERM"
): number {
  if (report.outcome === "passed") {
    return 0;
  }
  if (report.outcome === "cancelled") {
    return cancellationSignal === "SIGTERM" ? 143 : 130;
  }
  for (const task of report.tasks) {
    if (task.outcome === "timed-out") {
      return 124;
    }
    if (task.outcome === "failed") {
      return task.exitCode === null || task.exitCode === 0 ? 1 : task.exitCode;
    }
  }
  return 1;
}

export async function runQualityGateCommand(input: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly profileId: string;
  readonly format: "json" | "text";
  readonly environment: NodeJS.ProcessEnv;
  readonly pnpmEnvironment: QualityGatePnpmEnvironment;
}): Promise<void> {
  if (input.environment[ACTIVE_GATE_ENVIRONMENT_VARIABLE] !== undefined) {
    inputError(
      "QUALITY_GATE_RECURSION",
      "A quality gate task cannot start another quality gate runner."
    );
  }
  const controller = new AbortController();
  let cancellationSignal: "SIGINT" | "SIGTERM" | undefined;
  const cancelFor = (signal: "SIGINT" | "SIGTERM") => () => {
    cancellationSignal ??= signal;
    controller.abort(signal);
  };
  const onInterrupt = cancelFor("SIGINT");
  const onTerminate = cancelFor("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const policy = await loadQualityGatePolicy(
      input.consumerRoot,
      input.configPath,
      controller.signal
    );
    const profile = policy.profiles.find(({ id }) => id === input.profileId);
    if (profile === undefined) {
      inputError(
        "QUALITY_GATE_PROFILE_UNKNOWN",
        `Unknown quality gate profile: ${input.profileId}.`
      );
    }
    const catalog = await new FilesystemPackageScriptCatalogReader().read(
      input.consumerRoot,
      controller.signal
    );
    const diagnostics = evaluateQualityGateScripts(policy, catalog);
    if (diagnostics.length > 0) {
      inputError(
        "QUALITY_GATE_SCRIPTS_INVALID",
        diagnostics.map(({ message }) => message).join(" ")
      );
    }
    input.environment[ACTIVE_GATE_ENVIRONMENT_VARIABLE] = input.profileId;
    let report: QualityGateRunReport;
    try {
      report = await runQualityGateProfile(
        {
          consumerRoot: input.consumerRoot,
          profile,
          signal: controller.signal
        },
        new PnpmQualityGateScriptExecutor(input.pnpmEnvironment),
        performanceMonotonicClock
      );
    } finally {
      delete input.environment[ACTIVE_GATE_ENVIRONMENT_VARIABLE];
    }
    process.stdout.write(
      input.format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderQualityGateRunReport(report)
    );
    process.exitCode = exitCodeForQualityGateRun(report, cancellationSignal);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

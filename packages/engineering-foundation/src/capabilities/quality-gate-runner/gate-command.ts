import { CapabilityInputError } from "../../capability-runtime.js";
import type { QualityGateRunReport } from "./application/model/quality-gate-report.js";
import type { QualityGateOperatorCancellationSource } from "./application/ports/operator-cancellation-source.js";
import type { PackageScriptExecutor } from "./application/ports/package-script-executor.js";
import { evaluateQualityGateScripts } from "./application/policies/evaluate-quality-gate-scripts.js";
import { runQualityGateProfile } from "./application/use-cases/run-quality-gate-profile.js";
import { renderQualityGateRunReport } from "./adapters/inbound/cli/report-renderer.js";
import { FilesystemPackageScriptCatalogReader } from "./adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
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
  cancellation?: "interrupt" | "terminate"
): number {
  if (report.outcome === "passed") {
    return 0;
  }
  if (report.outcome === "cancelled") {
    return cancellation === "terminate" ? 143 : 130;
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
  readonly cancellationSource: QualityGateOperatorCancellationSource;
  readonly executor: PackageScriptExecutor;
}): Promise<void> {
  if (input.environment[ACTIVE_GATE_ENVIRONMENT_VARIABLE] !== undefined) {
    inputError(
      "QUALITY_GATE_RECURSION",
      "A quality gate task cannot start another quality gate runner."
    );
  }
  const controller = new AbortController();
  let cancellation: "interrupt" | "terminate" | undefined;
  const unsubscribe = input.cancellationSource.subscribe((requested) => {
    cancellation ??= requested;
    controller.abort(requested);
  });
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
        input.executor,
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
    process.exitCode = exitCodeForQualityGateRun(report, cancellation);
  } finally {
    unsubscribe();
  }
}

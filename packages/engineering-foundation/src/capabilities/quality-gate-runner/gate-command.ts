import { CapabilityInputError } from "../../capability-runtime.js";
import type { ParsedArguments } from "../../cli-arguments.js";
import { FoundationError } from "../../errors.js";
import { loadFoundationConfig } from "../../foundation-config.js";
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

async function runQualityGateCommand(input: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly profileId: string;
  readonly format: "json" | "text";
  readonly pnpmEnvironment: QualityGatePnpmEnvironment;
}): Promise<void> {
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
    const report = await runQualityGateProfile(
      {
        consumerRoot: input.consumerRoot,
        profile,
        signal: controller.signal
      },
      new PnpmQualityGateScriptExecutor(input.pnpmEnvironment),
      performanceMonotonicClock
    );
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

export async function tryRunQualityGateCommand(
  parsed: ParsedArguments,
  environment: NodeJS.ProcessEnv
): Promise<boolean> {
  if (parsed.command !== "gate.run") {
    return false;
  }
  const profileId = parsed.positional[0];
  if (profileId === undefined) {
    throw new FoundationError("CONSUMER_INVALID", "gate run requires a profile ID.");
  }
  const settings = await loadFoundationConfig(parsed.consumerRoot);
  const declaration = settings.declaredCapabilities.find(
    ({ id }) => id === "quality.gate-runner"
  );
  if (declaration === undefined) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "The consumer must declare quality.gate-runner before using gate run."
    );
  }
  await runQualityGateCommand({
    consumerRoot: parsed.consumerRoot,
    configPath: declaration.configPath,
    profileId,
    format: parsed.format,
    pnpmEnvironment: {
      ...(environment.npm_execpath === undefined ? {} : { npmExecPath: environment.npm_execpath }),
      ...(environment.PNPM_HOME === undefined ? {} : { pnpmHome: environment.PNPM_HOME }),
      ...(environment.PATH === undefined ? {} : { pathValue: environment.PATH })
    }
  });
  return true;
}

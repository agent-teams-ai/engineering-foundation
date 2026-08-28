import { CapabilityInputError } from "../../capability-runtime.js";
import type { QualityGateRunReport } from "./application/model/quality-gate-report.js";
import type { MonotonicClock } from "./application/ports/monotonic-clock.js";
import type { QualityGateOperatorCancellationSource } from "./application/ports/operator-cancellation-source.js";
import type { PackageScriptCatalogReader } from "./application/ports/package-script-catalog-reader.js";
import type { PackageScriptExecutor } from "./application/ports/package-script-executor.js";
import { evaluateQualityGateScripts } from "./application/policies/evaluate-quality-gate-scripts.js";
import { runQualityGateProfile } from "./application/use-cases/run-quality-gate-profile.js";
import { renderQualityGateRunReport } from "./adapters/inbound/cli/report-renderer.js";
import { NodeSignalQualityGateCancellationSource } from "./adapters/inbound/cli/node-signal-cancellation-source.js";
import { FilesystemPackageScriptCatalogReader } from "./adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import { PnpmQualityGateScriptExecutor } from "./adapters/outbound/pnpm/pnpm-package-script-executor.js";
import { performanceMonotonicClock } from "./adapters/outbound/time/performance-monotonic-clock.js";
import {
  loadQualityGatePolicy,
  type QualityGatePolicyLoader
} from "./contract/config.js";

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
  if (cancellation !== undefined && report.outcome !== "failed") {
    return cancellation === "terminate" ? 143 : 130;
  }
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

export interface QualityGateCommandInput {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly profileId: string;
  readonly format: "json" | "text";
  readonly environment: NodeJS.ProcessEnv;
}

export interface QualityGateCommandDependencies {
  readonly cancellationSource: QualityGateOperatorCancellationSource;
  readonly catalogReader: PackageScriptCatalogReader;
  readonly clock: MonotonicClock;
  readonly executor: PackageScriptExecutor;
  readonly policyLoader: QualityGatePolicyLoader;
}

export type QualityGateCommand = (input: QualityGateCommandInput) => Promise<void>;

function cancelledExitCode(
  cancellation: "interrupt" | "terminate" | undefined
): number | undefined {
  if (cancellation === "interrupt") {
    return 130;
  }
  if (cancellation === "terminate") {
    return 143;
  }
  return undefined;
}

export function createQualityGateCommand(
  dependencies: QualityGateCommandDependencies
): QualityGateCommand {
  return async (input) => {
    if (input.environment[ACTIVE_GATE_ENVIRONMENT_VARIABLE] !== undefined) {
      inputError(
        "QUALITY_GATE_RECURSION",
        "A quality gate task cannot start another quality gate runner."
      );
    }
    const controller = new AbortController();
    let cancellation: "interrupt" | "terminate" | undefined;
    const observedCancellationExitCode = () => cancelledExitCode(cancellation);
    const unsubscribe = dependencies.cancellationSource.subscribe((requested) => {
      cancellation ??= requested;
      controller.abort(requested);
    });
    try {
      const policy = await dependencies.policyLoader(
        input.consumerRoot,
        input.configPath,
        controller.signal
      );
      const configurationCancellationExitCode = observedCancellationExitCode();
      if (configurationCancellationExitCode !== undefined) {
        process.exitCode = configurationCancellationExitCode;
        return;
      }
      const profile = policy.profiles.find(({ id }) => id === input.profileId);
      if (profile === undefined) {
        inputError(
          "QUALITY_GATE_PROFILE_UNKNOWN",
          `Unknown quality gate profile: ${input.profileId}.`
        );
      }
      const catalog = await dependencies.catalogReader.read(
        input.consumerRoot,
        controller.signal
      );
      const catalogCancellationExitCode = observedCancellationExitCode();
      if (catalogCancellationExitCode !== undefined) {
        process.exitCode = catalogCancellationExitCode;
        return;
      }
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
          dependencies.executor,
          dependencies.clock
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
    } catch (error) {
      const exitCode = observedCancellationExitCode();
      if (exitCode !== undefined) {
        process.exitCode = exitCode;
        return;
      }
      throw error;
    } finally {
      unsubscribe();
    }
  };
}

export function createNodeQualityGateCommand(
  environment: NodeJS.ProcessEnv
): QualityGateCommand {
  return createQualityGateCommand({
    cancellationSource: new NodeSignalQualityGateCancellationSource(),
    catalogReader: new FilesystemPackageScriptCatalogReader(),
    clock: performanceMonotonicClock,
    executor: new PnpmQualityGateScriptExecutor({
      ...(environment.npm_execpath === undefined
        ? {}
        : { npmExecPath: environment.npm_execpath }),
      ...(environment.PNPM_HOME === undefined
        ? {}
        : { pnpmHome: environment.PNPM_HOME }),
      ...(environment.PATH === undefined
        ? {}
        : { pathValue: environment.PATH })
    }),
    policyLoader: loadQualityGatePolicy
  });
}

/**
 * Compatibility seam for focused qualification that supplies controlled ports.
 * Production CLI composition uses createNodeQualityGateCommand instead.
 */
export async function runQualityGateCommand(input: QualityGateCommandInput & {
  readonly cancellationSource: QualityGateOperatorCancellationSource;
  readonly executor: PackageScriptExecutor;
}): Promise<void> {
  await createQualityGateCommand({
    cancellationSource: input.cancellationSource,
    catalogReader: new FilesystemPackageScriptCatalogReader(),
    clock: performanceMonotonicClock,
    executor: input.executor,
    policyLoader: loadQualityGatePolicy
  })(input);
}

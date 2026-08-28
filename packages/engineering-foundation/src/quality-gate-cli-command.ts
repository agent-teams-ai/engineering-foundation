import { CapabilityInputError } from "./capability-runtime.js";
import {
  createNodeQualityGateCancellationSource,
  createNodeQualityGateCommand,
  type QualityGateCommand,
  type QualityGateRunReport
} from "./capabilities/quality-gate-runner/gate-command.js";
import type { ParsedArguments } from "./cli-arguments.js";
import { foundationCommandFailure } from "./command-error.js";
import { FoundationError } from "./errors.js";
import {
  loadFoundationConfig,
  type FoundationSettings
} from "./foundation-config.js";

type QualityGateOperatorCancellation = "interrupt" | "terminate";

interface QualityGateCancellationSource {
  subscribe(
    onCancellation: (cancellation: QualityGateOperatorCancellation) => void
  ): () => void;
}

interface QualityGateCliCommandDependencies {
  readonly cancellationSource: QualityGateCancellationSource;
  readonly commandFactory: (
    environment: NodeJS.ProcessEnv
  ) => QualityGateCommand;
  readonly foundationConfigLoader: (
    consumerRoot: string,
    signal?: AbortSignal
  ) => Promise<FoundationSettings>;
}

type QualityGateCliCommand = (
  parsed: ParsedArguments,
  environment: NodeJS.ProcessEnv
) => Promise<boolean>;

function cancellationExitCode(
  cancellation: QualityGateOperatorCancellation
): 130 | 143 {
  return cancellation === "terminate" ? 143 : 130;
}

function exitCodeForQualityGateRun(
  report: QualityGateRunReport,
  cancellation: QualityGateOperatorCancellation | undefined
): number {
  if (cancellation !== undefined && report.outcome !== "failed") {
    return cancellationExitCode(cancellation);
  }
  if (report.outcome === "passed") {
    return 0;
  }
  for (const task of report.tasks) {
    if (task.outcome === "timed-out") {
      return 124;
    }
    if (task.outcome === "failed") {
      return task.exitCode === null || task.exitCode === 0 ? 1 : task.exitCode;
    }
  }
  return cancellation === undefined ? 130 : cancellationExitCode(cancellation);
}

function renderQualityGateRunReport(report: QualityGateRunReport): string {
  const lines = [
    `Quality gate profile: ${report.profileId}`,
    `Outcome: ${report.outcome}`,
    `Duration: ${report.durationMs}ms`
  ];
  for (const task of report.tasks) {
    const exit = task.exitCode === null ? "" : ` exit=${task.exitCode}`;
    const signal = task.signal === null ? "" : ` signal=${task.signal}`;
    lines.push(`- ${task.id}: ${task.outcome} (${task.durationMs}ms)${exit}${signal}`);
    if (task.failureTail.length > 0) {
      lines.push(task.failureTail);
    }
  }
  return `${lines.join("\n")}\n`;
}

function setupCancellationError(): CapabilityInputError {
  return new CapabilityInputError({
    code: "EXECUTION_CANCELLED",
    message: "Quality gate execution was cancelled.",
    phase: "quality-gate-runner-command",
    retryable: false
  });
}

function isExecutionCancellation(error: unknown): boolean {
  return error instanceof CapabilityInputError &&
    error.problem.code === "EXECUTION_CANCELLED";
}

function projectSetupCancellation(
  format: "json" | "text",
  cancellation: QualityGateOperatorCancellation
): void {
  if (format === "json") {
    const failure = foundationCommandFailure(setupCancellationError());
    process.stdout.write(`${JSON.stringify(failure.envelope)}\n`);
  } else {
    process.stderr.write("Quality gate execution was cancelled.\n");
  }
  process.exitCode = cancellationExitCode(cancellation);
}

function projectQualityGateRun(
  report: QualityGateRunReport,
  format: "json" | "text",
  cancellation: QualityGateOperatorCancellation | undefined
): void {
  process.stdout.write(
    format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderQualityGateRunReport(report)
  );
  process.exitCode = exitCodeForQualityGateRun(report, cancellation);
}

export function createQualityGateCliCommand(
  dependencies: QualityGateCliCommandDependencies
): QualityGateCliCommand {
  return async (parsed, environment) => {
    if (parsed.command !== "gate.run") {
      return false;
    }
    const profileId = parsed.positional[0];
    if (profileId === undefined) {
      throw new FoundationError("CONSUMER_INVALID", "gate run requires a profile ID.");
    }

    const controller = new AbortController();
    let cancellation: QualityGateOperatorCancellation | undefined;
    const unsubscribe = dependencies.cancellationSource.subscribe((requested) => {
      cancellation ??= requested;
      controller.abort(requested);
    });
    try {
      const settings = await dependencies.foundationConfigLoader(
        parsed.consumerRoot,
        controller.signal
      );
      if (cancellation !== undefined) {
        projectSetupCancellation(parsed.format, cancellation);
        return true;
      }
      const declaration = settings.declaredCapabilities.find(
        ({ id }) => id === "quality.gate-runner"
      );
      if (declaration === undefined) {
        throw new FoundationError(
          "CONSUMER_INVALID",
          "The consumer must declare quality.gate-runner before using gate run."
        );
      }
      const report = await dependencies.commandFactory(environment)({
        consumerRoot: parsed.consumerRoot,
        configPath: declaration.configPath,
        profileId,
        environment,
        signal: controller.signal
      });
      projectQualityGateRun(report, parsed.format, cancellation);
      return true;
    } catch (error) {
      if (cancellation !== undefined && isExecutionCancellation(error)) {
        projectSetupCancellation(parsed.format, cancellation);
        return true;
      }
      throw error;
    } finally {
      unsubscribe();
    }
  };
}

export async function tryRunQualityGateCliCommand(
  parsed: ParsedArguments,
  environment: NodeJS.ProcessEnv
): Promise<boolean> {
  return createQualityGateCliCommand({
    cancellationSource: createNodeQualityGateCancellationSource(),
    commandFactory: createNodeQualityGateCommand,
    foundationConfigLoader: loadFoundationConfig
  })(parsed, environment);
}

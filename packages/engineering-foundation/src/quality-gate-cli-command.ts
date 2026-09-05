import { CapabilityInputError } from "./capability-runtime.js";
import {
  createNodeQualityGateCommand,
  type QualityGateCommand
} from "./capabilities/quality-gate-runner/gate-command.js";
import {
  NodeSignalQualityGateCancellationSource
} from "./capabilities/quality-gate-runner/adapters/inbound/cli/node-signal-cancellation-source.js";
import {
  projectQualityGateRun,
  projectQualityGateSetupCancellation,
  type QualityGateCancellationSource,
  type QualityGateCliProjection,
  type QualityGateOperatorCancellation
} from "./capabilities/quality-gate-runner/adapters/inbound/cli/quality-gate-cli.js";
import type { ParsedArguments } from "./cli-arguments.js";
import { foundationCommandFailure } from "./command-error.js";
import { FoundationError } from "./local-mode/application/errors/foundation-error.js";
import {
  loadFoundationConfig,
  type FoundationSettings
} from "./foundation-config.js";

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

function isExecutionCancellation(error: unknown): boolean {
  return error instanceof CapabilityInputError &&
    error.problem.code === "EXECUTION_CANCELLED";
}

function setupCancellationFailureJson(): string {
  const error = new CapabilityInputError({
    code: "EXECUTION_CANCELLED",
    message: "Quality gate execution was cancelled.",
    phase: "quality-gate-runner-command",
    retryable: false
  });
  return JSON.stringify(foundationCommandFailure(error).envelope);
}

function writeProjection(
  projection: QualityGateCliProjection
): void {
  if (projection.stdout.length > 0) {
    process.stdout.write(projection.stdout);
  }
  if (projection.stderr.length > 0) {
    process.stderr.write(projection.stderr);
  }
  process.exitCode = projection.exitCode;
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
        writeProjection(
          projectQualityGateSetupCancellation(
            parsed.format,
            cancellation,
            setupCancellationFailureJson()
          )
        );
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
        signal: controller.signal
      });
      writeProjection(projectQualityGateRun(report, parsed.format, cancellation));
      return true;
    } catch (error) {
      if (cancellation !== undefined && isExecutionCancellation(error)) {
        writeProjection(
          projectQualityGateSetupCancellation(
            parsed.format,
            cancellation,
            setupCancellationFailureJson()
          )
        );
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
    cancellationSource: new NodeSignalQualityGateCancellationSource(),
    commandFactory: createNodeQualityGateCommand,
    foundationConfigLoader: loadFoundationConfig
  })(parsed, environment);
}

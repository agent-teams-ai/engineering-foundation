import { CapabilityInputError } from "../../../../../features/validation-reporting/api.js";
import type { QualityGateCommand } from "../../../api.js";
import {
  projectQualityGateRun,
  projectQualityGateSetupCancellation,
  type QualityGateCancellationSource,
  type QualityGateCliProjection,
  type QualityGateOperatorCancellation
} from "./quality-gate-cli.js";
import { FoundationError } from "../../../../../errors.js";
import type { FoundationConfigReader } from "../../../../../features/foundation-check/api.js";

export interface QualityGateCliCommandDependencies {
  readonly failureJson: (error: unknown) => string;
  readonly cancellationSource: QualityGateCancellationSource;
  readonly commandFactory: (
    environment: NodeJS.ProcessEnv
  ) => QualityGateCommand;
  readonly foundationConfigLoader: FoundationConfigReader;
}

export interface QualityGateCliArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly consumerRoot: string;
  readonly format: "json" | "text";
}

export type QualityGateCliCommand = (
  parsed: QualityGateCliArguments,
  environment: NodeJS.ProcessEnv
) => Promise<boolean>;

function isExecutionCancellation(error: unknown): boolean {
  return error instanceof CapabilityInputError &&
    error.problem.code === "EXECUTION_CANCELLED";
}

function setupCancellationFailureJson(failureJson: (error: unknown) => string): string {
  const error = new CapabilityInputError({
    code: "EXECUTION_CANCELLED",
    message: "Quality gate execution was cancelled.",
    phase: "quality-gate-runner-command",
    retryable: false
  });
  return failureJson(error);
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
            setupCancellationFailureJson(dependencies.failureJson)
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
            setupCancellationFailureJson(dependencies.failureJson)
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


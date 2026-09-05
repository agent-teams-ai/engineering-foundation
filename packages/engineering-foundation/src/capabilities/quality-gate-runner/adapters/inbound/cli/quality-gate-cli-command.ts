import { isQualityGateExecutionCancellation, qualityGateSetupCancellationFailure, requireQualityGateConfigPath, requireQualityGateProfile } from "../../../application/policies/quality-gate-input.js";
import type { QualityGateCommand } from "../../../api.js";
import {
  projectQualityGateRun,
  projectQualityGateSetupCancellation,
  type QualityGateCancellationSource,
  type QualityGateCliProjection,
  type QualityGateOperatorCancellation
} from "./quality-gate-cli.js";
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

function setupCancellationFailureJson(failureJson: (error: unknown) => string): string {
  const error = qualityGateSetupCancellationFailure();
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
    const profileId = requireQualityGateProfile(parsed.positional[0]);

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
      const configPath = requireQualityGateConfigPath(settings.declaredCapabilities);
      const report = await dependencies.commandFactory(environment)({
        consumerRoot: parsed.consumerRoot,
        configPath,
        profileId,
        signal: controller.signal
      });
      writeProjection(projectQualityGateRun(report, parsed.format, cancellation));
      return true;
    } catch (error) {
      if (cancellation !== undefined && isQualityGateExecutionCancellation(error)) {
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


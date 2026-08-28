import { runQualityGateCommand } from "./capabilities/quality-gate-runner/gate-command.js";
import { NodeSignalQualityGateCancellationSource } from "./capabilities/quality-gate-runner/adapters/inbound/cli/node-signal-cancellation-source.js";
import { PnpmQualityGateScriptExecutor } from "./capabilities/quality-gate-runner/adapters/outbound/pnpm/pnpm-package-script-executor.js";
import type { ParsedArguments } from "./cli-arguments.js";
import { FoundationError } from "./errors.js";
import { loadFoundationConfig } from "./foundation-config.js";

export async function tryRunQualityGateCliCommand(
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
    environment,
    cancellationSource: new NodeSignalQualityGateCancellationSource(),
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
    })
  });
  return true;
}

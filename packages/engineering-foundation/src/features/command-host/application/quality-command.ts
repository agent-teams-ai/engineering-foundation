import type { CommandInvocation } from "./command-invocation.js";
import type { FoundationCommandServices } from "./command-services.js";
import { invalidCommand, selectedCommandReport } from "./command-reporting.js";

export interface QualityCommand {
  readonly operation: "check" | "format";
  readonly consumerRoot: string;
  readonly scopeOnly: boolean;
}

export function admitQualityCommand(input: CommandInvocation): QualityCommand | undefined {
  if (input.command !== "quality") {
    return undefined;
  }
  const operation = input.positional[0];
  if (input.positional.length !== 1 || (operation !== "check" && operation !== "format")) {
    throw invalidCommand("quality requires the check or format subcommand.");
  }
  return { operation, consumerRoot: input.consumerRoot, scopeOnly: input.scopeOnly === true };
}

export async function executeQualityCommand(
  services: Pick<
    FoundationCommandServices,
    "cancellation" | "readConfig" | "qualityFormat" | "qualityCoverage" | "installedVersion"
  >,
  input: QualityCommand,
  publish: (report: ReturnType<typeof selectedCommandReport>) => void,
) {
  return services.cancellation.withSignal(["SIGINT", "SIGTERM"], async (signal) => {
    const format = input.operation === "format";
    const capabilityId = format ? "quality.format-coverage" : "quality.source-coverage";
    const settings = await services.readConfig(input.consumerRoot, signal);
    const declaration = settings.declaredCapabilities.find(({ id }) => id === capabilityId);
    if (declaration === undefined) {
      throw invalidCommand(`${capabilityId} must be declared before quality ${input.operation}.`);
    }
    const report = selectedCommandReport(
      await (format ? services.qualityFormat : services.qualityCoverage)({
        consumerRoot: input.consumerRoot,
        configPath: declaration.configPath,
        scopeOnly: input.scopeOnly,
        signal,
      }),
      await services.installedVersion(),
    );
    publish(report);
  });
}

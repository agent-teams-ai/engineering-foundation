import type { CommandInvocation } from "./command-invocation.js";
import type { FoundationCommandServices } from "./command-services.js";

export interface CheckCommand {
  readonly consumerRoot: string;
  readonly capabilityId?: string;
}

export function admitCheckCommand(input: CommandInvocation): CheckCommand | undefined {
  if (input.command !== "check") {
    return undefined;
  }
  return {
    consumerRoot: input.consumerRoot,
    ...(input.positional[0] === undefined ? {} : { capabilityId: input.positional[0] }),
  };
}

export async function executeCheckCommand(
  services: Pick<FoundationCommandServices, "cancellation" | "check" | "installedVersion">,
  input: CheckCommand,
  publish: (report: Awaited<ReturnType<FoundationCommandServices["check"]>>) => void,
) {
  return services.cancellation.withSignal(["SIGINT"], async (signal) => {
    const report = await services.check({
      ...input,
      foundationVersion: await services.installedVersion(),
      signal,
    });
    publish(report);
  });
}

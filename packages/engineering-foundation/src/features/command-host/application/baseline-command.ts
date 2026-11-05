import type { CommandInvocation } from "./command-invocation.js";
import type { FoundationCommandServices } from "./command-services.js";
import { invalidCommand, selectedCommandReport } from "./command-reporting.js";

export interface BaselineCommand {
  readonly action: "check" | "init" | "prune";
  readonly consumerRoot: string;
  readonly configPath: string;
}

export function admitBaselineCommand(input: CommandInvocation): BaselineCommand | undefined {
  if (input.command !== "baseline") {
    return undefined;
  }
  const action = input.positional[0];
  if (action !== "check" && action !== "init" && action !== "prune") {
    throw invalidCommand("baseline requires the check, init or prune subcommand.");
  }
  return { action, consumerRoot: input.consumerRoot, configPath: input.configPath };
}

export type BaselineCommandResult =
  | { readonly kind: "check"; readonly report: ReturnType<typeof selectedCommandReport> }
  | {
      readonly kind: "write";
      readonly result: Awaited<ReturnType<FoundationCommandServices["findingsBaseline"]["write"]>>;
    };

export async function executeBaselineCommand(
  services: Pick<
    FoundationCommandServices,
    "cancellation" | "findingsBaseline" | "installedVersion"
  >,
  input: BaselineCommand,
  publish: (result: BaselineCommandResult) => void,
) {
  return services.cancellation.withSignal(["SIGINT", "SIGTERM"], async (signal) => {
    const invocation = { consumerRoot: input.consumerRoot, configPath: input.configPath, signal };
    if (input.action === "check") {
      publish({
        kind: "check",
        report: selectedCommandReport(
          await services.findingsBaseline.check(invocation),
          await services.installedVersion(),
        ),
      });
      return;
    }
    publish({
      kind: "write",
      result: await services.findingsBaseline.write({ ...invocation, action: input.action }),
    });
  });
}

import type { CommandInvocation } from "./command-invocation.js";
import type {
  CommandDevOnlyStatus,
  CommandModeStatus,
  FoundationCommandServices,
} from "./command-services.js";
import { invalidCommand } from "./command-reporting.js";

export type LocalModeCommand =
  | { readonly command: "attach"; readonly consumerRoot: string; readonly target: string }
  | {
      readonly command: "status" | "detach" | "assert-registry" | "assert-dev-only";
      readonly consumerRoot: string;
    };

export type LocalModeCommandResult =
  | { readonly kind: "status" | "inspection"; readonly status: CommandModeStatus }
  | { readonly kind: "dev-only"; readonly status: CommandDevOnlyStatus };

export function admitLocalModeCommand(input: CommandInvocation): LocalModeCommand | undefined {
  switch (input.command) {
    case "attach": {
      const target = input.positional[0];
      if (target === undefined) {
        throw invalidCommand("attach requires a foundation repository or package path.");
      }
      return { command: input.command, consumerRoot: input.consumerRoot, target };
    }
    case "status":
    case "detach":
    case "assert-registry":
    case "assert-dev-only":
      return { command: input.command, consumerRoot: input.consumerRoot };
    default:
      return undefined;
  }
}

export async function executeLocalModeCommand(
  service: FoundationCommandServices["localMode"],
  input: LocalModeCommand,
): Promise<LocalModeCommandResult> {
  switch (input.command) {
    case "attach":
      return {
        kind: "status",
        status: (await service.attach(input.consumerRoot, input.target)).status,
      };
    case "assert-dev-only":
      return { kind: "dev-only", status: await service.assertDevOnly(input.consumerRoot) };
    case "assert-registry":
      return { kind: "status", status: await service.assertRegistry(input.consumerRoot) };
    case "detach":
      return { kind: "status", status: await service.detach(input.consumerRoot) };
    case "status": {
      const status = await service.status(input.consumerRoot);
      return { kind: "inspection", status };
    }
  }
}

import { FoundationError } from "../../validation-reporting/api.js";
import type { CommandInvocation } from "./command-invocation.js";

export type FoundationCommandHandler = (invocation: CommandInvocation) => Promise<boolean>;

export async function dispatchFoundationCommand(
  invocation: CommandInvocation,
  handlers: readonly FoundationCommandHandler[]
): Promise<void> {
  for (const handler of handlers) {
    if (await handler(invocation)) {
      return;
    }
  }
  throw new FoundationError("CONSUMER_INVALID", `Unknown command: ${invocation.command}.`);
}

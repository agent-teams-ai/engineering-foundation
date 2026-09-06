import { CapabilityInputError, FoundationError, exitCodeForOutcome } from "../../validation-reporting/api.js";
import type { FoundationOutcome } from "../../validation-reporting/api.js";

export interface FoundationCommandErrorEnvelope {
  readonly schemaVersion: 1;
  readonly outcome: "cancelled" | "execution-failure" | "invalid-input";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export function boundedCommandMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000) || "Command failed without an error message.";
}

export function commandInputFailure(error: unknown): {
  readonly envelope: FoundationCommandErrorEnvelope;
  readonly exitCode: 1 | 2 | 130;
} | undefined {
  if (error instanceof CapabilityInputError) {
    const cancelled = error.problem.code === "EXECUTION_CANCELLED";
    return {
      envelope: {
        schemaVersion: 1,
        outcome: cancelled ? "cancelled" : "invalid-input",
        error: {
          code: error.problem.code,
          message: error.problem.message,
          retryable: error.problem.retryable,
        },
      },
      exitCode: cancelled ? 130 : 2,
    };
  }
  return undefined;
}

export function commandFoundationFailure(error: unknown): {
  readonly envelope: FoundationCommandErrorEnvelope;
  readonly exitCode: 1 | 2 | 130;
} | undefined {
  if (error instanceof FoundationError) {
    const invalidInput = error.code === "CONSUMER_INVALID";
    return {
      envelope: {
        schemaVersion: 1,
        outcome: invalidInput ? "invalid-input" : "execution-failure",
        error: {
          code: error.code,
          message: boundedCommandMessage(error),
          retryable: false,
        },
      },
      exitCode: invalidInput ? 2 : 1,
    };
  }
  return undefined;
}

export function invalidCommand(message: string): FoundationError {
  return new FoundationError("CONSUMER_INVALID", message);
}

export function checkCommandExitCode(outcome: FoundationOutcome): number {
  return exitCodeForOutcome(outcome);
}

/** Text keeps the full original message; the adapter reads exitCode after publishing it. */
export function commandInputText(error: unknown): { readonly text: string; readonly exitCode: 2 | 130 } | undefined {
  if (error instanceof CapabilityInputError) {
    return {
      text: `${error.problem.code}: ${error.problem.message}\n`,
      get exitCode() { return error.problem.code === "EXECUTION_CANCELLED" ? 130 : 2; }
    };
  }
  return undefined;
}

export function commandFoundationText(error: unknown): { readonly text: string; readonly exitCode: 1 | 2 } | undefined {
  if (error instanceof FoundationError) {
    return {
      text: `${error.code}: ${error.message}\n`,
      get exitCode() { return error.code === "CONSUMER_INVALID" ? 2 : 1; }
    };
  }
  return undefined;
}

import { commandInputFailure, commandFoundationFailure, boundedCommandMessage } from "../../../application/command-reporting.js";
import { ProcessCancellationError } from "../../../../../process-execution/api.js";
import { ScaffoldError } from "../../../../../scaffolding/scaffold-error.js";
import { FoundationTransactionError } from "../../../../../transaction-coordination/application/foundation-transaction-error.js";

export type { FoundationCommandErrorEnvelope } from "../../../application/command-reporting.js";
import type { FoundationCommandErrorEnvelope } from "../../../application/command-reporting.js";

export function foundationCommandFailure(error: unknown): {
  readonly envelope: FoundationCommandErrorEnvelope;
  readonly exitCode: 1 | 2 | 130;
} {
  const inputFailure = commandInputFailure(error);
  if (inputFailure !== undefined) { return inputFailure; }
  if (error instanceof ProcessCancellationError) {
    return {
      envelope: {
        schemaVersion: 1,
        outcome: "cancelled",
        error: {
          code: "PROCESS_CANCELLED",
          message: boundedCommandMessage(error),
          retryable: false,
        },
      },
      exitCode: 130,
    };
  }
  if (error instanceof ScaffoldError) {
    const invalidInput =
      error.code === "SCAFFOLD_INPUT_INVALID" ||
      error.code === "SCAFFOLD_PLAN_INVALID";
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
  if (error instanceof FoundationTransactionError) {
    return {
      envelope: {
        schemaVersion: 1,
        outcome: "execution-failure",
        error: {
          code: error.code,
          message: boundedCommandMessage(error),
          retryable: false,
        },
      },
      exitCode: 1,
    };
  }
  const foundationFailure = commandFoundationFailure(error);
  if (foundationFailure !== undefined) { return foundationFailure; }
  return {
    envelope: {
      schemaVersion: 1,
      outcome: "execution-failure",
      error: {
        code: "UNEXPECTED",
        message: boundedCommandMessage(error),
        retryable: false,
      },
    },
    exitCode: 1,
  };
}

export function foundationCommandFailureJson(error: unknown): string {
  return JSON.stringify(foundationCommandFailure(error).envelope);
}

import { commandInputFailure, commandFoundationFailure, boundedCommandMessage } from "./command-reporting.js";
import { ProcessCancellationError } from "../../../process-execution/api.js";
import { ScaffoldError } from "../../../scaffolding/scaffold-error.js";
import { FoundationTransactionError } from "../../../transaction-coordination/application/foundation-transaction-error.js";

export type { FoundationCommandErrorEnvelope } from "./command-reporting.js";
import type { FoundationCommandErrorEnvelope } from "./command-reporting.js";

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

/** Text precedence differs from JSON; exit codes are read after publishing text. */
export function commandTransactionText(error: unknown): { readonly text: string; readonly exitCode: 1 | 2 } | undefined {
  if (error instanceof FoundationTransactionError) {
    return { text: `${error.code}: ${error.message}\n`, exitCode: 1 };
  }
  if (error instanceof ScaffoldError) {
    return {
      text: `${error.code}: ${error.message}\n`,
      get exitCode() {
        return error.code === "SCAFFOLD_INPUT_INVALID" || error.code === "SCAFFOLD_PLAN_INVALID" ? 2 : 1;
      }
    };
  }
  return undefined;
}

export function commandCancellationText(error: unknown): { readonly text: string; readonly exitCode: 130 } | undefined {
  if (error instanceof ProcessCancellationError) {
    return { text: `PROCESS_CANCELLED: ${error.message}\n`, exitCode: 130 };
  }
  return undefined;
}

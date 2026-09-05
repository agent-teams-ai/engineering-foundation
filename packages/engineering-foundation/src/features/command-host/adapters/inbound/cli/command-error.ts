import { CapabilityInputError,FoundationError } from "../../../../validation-reporting/api.js";
import { ProcessCancellationError } from "../../../../../process-execution/api.js";
import { ScaffoldError } from "../../../../../scaffolding/scaffold-error.js";
import { FoundationTransactionError } from "../../../../../transaction-coordination/application/foundation-transaction-error.js";

export interface FoundationCommandErrorEnvelope {
  readonly schemaVersion: 1;
  readonly outcome: "cancelled" | "execution-failure" | "invalid-input";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000) || "Command failed without an error message.";
}

export function foundationCommandFailure(error: unknown): {
  readonly envelope: FoundationCommandErrorEnvelope;
  readonly exitCode: 1 | 2 | 130;
} {
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
  if (error instanceof ProcessCancellationError) {
    return {
      envelope: {
        schemaVersion: 1,
        outcome: "cancelled",
        error: {
          code: "PROCESS_CANCELLED",
          message: boundedMessage(error),
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
          message: boundedMessage(error),
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
          message: boundedMessage(error),
          retryable: false,
        },
      },
      exitCode: 1,
    };
  }
  if (error instanceof FoundationError) {
    const invalidInput = error.code === "CONSUMER_INVALID";
    return {
      envelope: {
        schemaVersion: 1,
        outcome: invalidInput ? "invalid-input" : "execution-failure",
        error: {
          code: error.code,
          message: boundedMessage(error),
          retryable: false,
        },
      },
      exitCode: invalidInput ? 2 : 1,
    };
  }
  return {
    envelope: {
      schemaVersion: 1,
      outcome: "execution-failure",
      error: {
        code: "UNEXPECTED",
        message: boundedMessage(error),
        retryable: false,
      },
    },
    exitCode: 1,
  };
}

export function foundationCommandFailureJson(error: unknown): string {
  return JSON.stringify(foundationCommandFailure(error).envelope);
}

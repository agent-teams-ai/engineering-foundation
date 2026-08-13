import { CapabilityInputError } from "../../../capability-runtime.js";
import { FoundationError } from "../../../errors.js";
import type {
  DocumentCommandDiagnostic,
  DocumentCommandExecution,
  DocumentCommandId,
  DocumentCommandOutcome
} from "../model/document-command.js";
import type { DocumentReceipt } from "../model/document-receipt.js";
import { DocumentPlanningError } from "../../document-planning-error.js";

const MAXIMUM_DIAGNOSTICS = 256;

export function commandExecution<Result>(input: {
  readonly command: DocumentCommandId;
  readonly diagnostics?: readonly DocumentCommandDiagnostic[];
  readonly outcome: DocumentCommandOutcome;
  readonly result: Result;
}): DocumentCommandExecution<Result> {
  return Object.freeze({
    envelope: Object.freeze({
      schemaVersion: 2,
      command: input.command,
      outcome: input.outcome,
      diagnostics: Object.freeze((input.diagnostics ?? []).slice(0, MAXIMUM_DIAGNOSTICS)),
      result: Object.freeze(input.result)
    }),
    exitCode: exitCodeForDocumentCommandOutcome(input.outcome)
  });
}

export function exitCodeForDocumentCommandOutcome(
  outcome: DocumentCommandOutcome
): 0 | 1 | 2 | 3 | 130 {
  switch (outcome) {
    case "success": return 0;
    case "authority-stale":
    case "conflict":
    case "recovery-required":
    case "violation": return 1;
    case "invalid-input": return 2;
    case "execution-failure": return 3;
    case "cancelled": return 130;
  }
}

export function receiptOutcome(receipt: DocumentReceipt): DocumentCommandOutcome {
  switch (receipt.outcome) {
    case "applied":
    case "already-applied": return "success";
    case "authority-stale": return "authority-stale";
    case "rejected": return "conflict";
    case "recovery-required":
    case "manual-recovery-required": return "recovery-required";
    case "failed-before-publication": return "execution-failure";
    case "cancelled": return "cancelled";
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

export function projectDocumentCommandFailure(input: {
  readonly allowCancellation?: boolean;
  readonly command: DocumentCommandId;
  readonly error: unknown;
  readonly phase: DocumentCommandDiagnostic["phase"];
  readonly subject: string;
}): {
  readonly diagnostic: DocumentCommandDiagnostic;
  readonly outcome: DocumentCommandOutcome;
} {
  const { command, error, phase, subject } = input;
  if (input.allowCancellation !== false && (
    (error instanceof CapabilityInputError &&
      error.problem.code === "EXECUTION_CANCELLED") ||
    (error instanceof Error && error.name === "AbortError")
  )) {
    return {
      diagnostic: {
        ruleId: `${command}.cancelled`, severity: "error", phase,
        subject, message: message(error)
      },
      outcome: "cancelled"
    };
  }
  if (error instanceof DocumentPlanningError) {
    const outcome = error.code === "DOCUMENT_PLANNING_AUTHORITY_CHANGED"
      ? "authority-stale" as const
      : error.code === "DOCUMENT_PLANNING_CONFLICT"
        ? "conflict" as const
        : "invalid-input" as const;
    return {
      diagnostic: {
        ruleId: `${command}.${outcome}`, severity: "error",
        phase: outcome === "authority-stale" ? "authority" : phase,
        subject, message: message(error)
      },
      outcome
    };
  }
  if (error instanceof CapabilityInputError ||
    (error instanceof FoundationError && error.code === "CONSUMER_INVALID")) {
    return {
      diagnostic: {
        ruleId: `${command}.invalid-input`, severity: "error", phase: "input",
        subject, message: message(error)
      },
      outcome: "invalid-input"
    };
  }
  return {
    diagnostic: {
      ruleId: `${command}.execution-failure`, severity: "error", phase,
      subject, message: message(error)
    },
    outcome: "execution-failure"
  };
}

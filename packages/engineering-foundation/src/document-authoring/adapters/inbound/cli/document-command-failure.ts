import type {
  DocumentCommandExecution,
  DocumentCommandId,
  DocumentDoctorResult,
  DocumentNewResult,
  DocumentRecoverResult
} from "../../../application/model/document-command.js";
import {
  commandExecution,
  projectDocumentCommandFailure
} from "../../../application/policies/document-command-projection.js";

type DocumentMutationResult =
  | DocumentDoctorResult
  | DocumentNewResult
  | DocumentRecoverResult;

function failureResult(command: DocumentCommandId): DocumentMutationResult {
  switch (command) {
    case "docs.new":
      return { kind: "new", reservation: "none" };
    case "docs.doctor":
      return {
        kind: "doctor",
        transactionState: "unknown",
        recoveryClass: "manual"
      };
    case "docs.recover":
      return {
        kind: "recover",
        transactionState: "failed",
        writeState: "unchanged",
        recoveryRequired: false
      };
  }
}

export function documentMutationFailure(
  command: DocumentCommandId,
  error: unknown
): DocumentCommandExecution<DocumentMutationResult> {
  const failure = projectDocumentCommandFailure({
    command,
    error,
    phase: "input",
    subject: command,
    allowCancellation: false
  });
  return commandExecution({
    command,
    diagnostics: [failure.diagnostic],
    outcome: failure.outcome,
    result: failureResult(command)
  });
}

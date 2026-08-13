import type {
  DocumentCommandDiagnostic,
  DocumentCommandExecution,
  DocumentDoctorResult
} from "../model/document-command.js";
import type { DocumentTransactionInspectionV1 } from "../model/document-transaction-inspection.js";
import {
  commandExecution,
  projectDocumentCommandFailure
} from "../policies/document-command-projection.js";

export interface RunDocumentDoctorRequest {
  readonly consumerRoot: string;
}

interface Dependencies {
  inspect(consumerRoot: string): Promise<DocumentTransactionInspectionV1>;
}

function inspectionDiagnostics(
  inspection: DocumentTransactionInspectionV1
): readonly DocumentCommandDiagnostic[] {
  if (inspection.state === "idle") {
    return [];
  }
  return inspection.diagnostics.map((entry) => ({
    ruleId: entry.code.toLowerCase().replaceAll("_", "."),
    severity: "error" as const,
    phase: "recovery" as const,
    subject: "document.transaction",
    message: entry.message,
    ...(inspection.state === "recoverable"
      ? { remediation: { commandId: "docs.recover" as const, args: {} } }
      : {})
  }));
}

export class RunDocumentDoctor {
  readonly #dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async execute(
    request: RunDocumentDoctorRequest
  ): Promise<DocumentCommandExecution<DocumentDoctorResult>> {
    try {
      const inspection = await this.#dependencies.inspect(request.consumerRoot);
      if (inspection.state === "idle") {
        return commandExecution({
          command: "docs.doctor", outcome: "success",
          result: { kind: "doctor", transactionState: "none", recoveryClass: "not-required" }
        });
      }
      if (inspection.state === "recoverable") {
        return commandExecution({
          command: "docs.doctor",
          diagnostics: inspectionDiagnostics(inspection),
          outcome: "recovery-required",
          result: {
            kind: "doctor", transactionState: "pending",
            protocolKind: "document-authoring",
            foundationVersion: inspection.foundationVersion,
            recoveryClass: "auto-recoverable"
          }
        });
      }
      const unknownVersion = inspection.diagnostics.some(
        ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"
      );
      return commandExecution({
        command: "docs.doctor",
        diagnostics: inspectionDiagnostics(inspection),
        outcome: "recovery-required",
        result: {
          kind: "doctor",
          transactionState: unknownVersion ? "unknown-version" : "tampered",
          ...(inspection.operationKind === "document-authoring" ||
            inspection.operationKind === "local-mode" ||
            inspection.operationKind === "scaffolding"
            ? { protocolKind: inspection.operationKind }
            : {}),
          recoveryClass: "manual"
        }
      });
    } catch (error) {
      const failure = projectDocumentCommandFailure({
        command: "docs.doctor", error, phase: "recovery", subject: "document.transaction"
      });
      return commandExecution({
        command: "docs.doctor", diagnostics: [failure.diagnostic], outcome: failure.outcome,
        result: { kind: "doctor", transactionState: "tampered", recoveryClass: "manual" }
      });
    }
  }
}

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
  readonly signal?: AbortSignal;
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

function manualTransactionState(
  inspection: Extract<DocumentTransactionInspectionV1, {
    readonly state: "manual-recovery-required";
  }>
): DocumentDoctorResult["transactionState"] {
  if (inspection.transactionKind !== undefined) {
    return inspection.transactionKind;
  }
  if (inspection.diagnostics.some(
    ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"
  )) {
    return "version-mismatch";
  }
  switch (inspection.operationKind) {
    case "document-authoring": return "document";
    case "local-mode": return "local-mode";
    case "scaffolding": return "scaffold";
    case undefined: return "unknown";
  }
  return "unknown";
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
      request.signal?.throwIfAborted();
      const inspection = await this.#dependencies.inspect(request.consumerRoot);
      request.signal?.throwIfAborted();
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
            kind: "doctor", transactionState: "document",
            protocolKind: "document-authoring",
            foundationVersion: inspection.foundationVersion,
            foundationBuildIdentity: inspection.foundationBuildIdentity,
            recoveryClass: "auto-recoverable",
            recoveryCommand: { commandId: "docs.recover", args: {} }
          }
        });
      }
      const exactRecovery = inspection.recovery;
      return commandExecution({
        command: "docs.doctor",
        diagnostics: inspectionDiagnostics(inspection),
        outcome: "recovery-required",
        result: {
          kind: "doctor",
          transactionState: manualTransactionState(inspection),
          ...(inspection.operationKind === "document-authoring" ||
            inspection.operationKind === "local-mode" ||
            inspection.operationKind === "scaffolding"
            ? { protocolKind: inspection.operationKind }
            : { protocolKind: "unknown" as const }),
          ...(inspection.foundationVersion === undefined
            ? {} : { foundationVersion: inspection.foundationVersion }),
          ...(inspection.foundationBuildIdentity === undefined
            ? {} : { foundationBuildIdentity: inspection.foundationBuildIdentity }),
          recoveryClass: "manual",
          ...(exactRecovery === undefined
            ? {}
            : { recoveryCommand: {
                commandId: exactRecovery.commandId === "docs-recover"
                  ? "docs.recover" as const : exactRecovery.commandId,
                args: exactRecovery.args
              } })
        }
      });
    } catch (error) {
      const failure = projectDocumentCommandFailure({
        command: "docs.doctor", error, phase: "recovery", subject: "document.transaction"
      });
      return commandExecution({
        command: "docs.doctor", diagnostics: [failure.diagnostic], outcome: failure.outcome,
        result: {
          kind: "doctor", transactionState: "unknown", protocolKind: "unknown",
          recoveryClass: "manual"
        }
      });
    }
  }
}

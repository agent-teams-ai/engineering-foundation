import type {
  DocumentCommandDiagnostic,
  DocumentCommandExecution,
  DocumentDoctorResult
} from "../model/document-command.js";
import type { DocumentTransactionInspectionV1 } from "../model/document-transaction-inspection.js";
import type {
  DocumentEnvironmentInspection,
  DocumentEnvironmentInspector
} from "../ports/document-environment-inspector.js";
import {
  commandExecution,
  projectDocumentCommandFailure
} from "../policies/document-command-projection.js";

export interface RunDocumentDoctorRequest {
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}

interface Dependencies {
  readonly environment: DocumentEnvironmentInspector;
  inspect(consumerRoot: string): Promise<DocumentTransactionInspectionV1>;
}

function environmentResult(environment: Awaited<
  ReturnType<DocumentEnvironmentInspector["inspect"]>
>): Pick<
  DocumentDoctorResult,
  "filesystem" | "installedFoundationBuildIdentity" | "installedFoundationVersion"
> {
  return {
    filesystem: environment.filesystem,
    installedFoundationBuildIdentity: environment.installedFoundationBuildIdentity,
    installedFoundationVersion: environment.installedFoundationVersion
  };
}

function unsupportedDurabilityDiagnostic(): DocumentCommandDiagnostic {
  return {
    ruleId: "document.environment.strict-directory-durability-unsupported",
    severity: "error",
    phase: "authority",
    subject: "filesystem.directory-durability",
    message:
      "Strict directory durability is unsupported for this consumer repository; document publication is unavailable on this filesystem."
  };
}

function inspectionDiagnostics(
  inspection: DocumentTransactionInspectionV1,
  consumerRoot: string
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
      ? { remediation: {
          commandId: "docs.recover" as const,
          args: {
            consumerRoot,
            exactFoundationVersion: inspection.recovery.exactFoundationVersion,
            exactFoundationBuildIdentity: inspection.recovery.exactFoundationBuildIdentity
          }
        } }
      : inspection.recovery === undefined
        ? {}
        : { remediation: {
            commandId: inspection.recovery.commandId === "docs-recover"
              ? "docs.recover" as const : inspection.recovery.commandId,
            args: { ...inspection.recovery.args, consumerRoot }
          } })
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
    let environment: DocumentEnvironmentInspection | undefined;
    try {
      request.signal?.throwIfAborted();
      environment = await this.#dependencies.environment.inspect(
        request.consumerRoot,
        request.signal
      );
      const inspection = await this.#dependencies.inspect(request.consumerRoot);
      request.signal?.throwIfAborted();
      if (inspection.state === "idle") {
        if (
          environment.filesystem.strictDirectoryDurability ===
            "platform-unsupported"
        ) {
          return commandExecution({
            command: "docs.doctor",
            diagnostics: [unsupportedDurabilityDiagnostic()],
            outcome: "violation",
            result: {
              kind: "doctor",
              ...environmentResult(environment),
              transactionState: "none",
              recoveryClass: "not-required"
            }
          });
        }
        return commandExecution({
          command: "docs.doctor", outcome: "success",
          result: {
            kind: "doctor", ...environmentResult(environment),
            transactionState: "none", recoveryClass: "not-required"
          }
        });
      }
      if (inspection.state === "recoverable") {
        return commandExecution({
          command: "docs.doctor",
          diagnostics: inspectionDiagnostics(inspection, request.consumerRoot),
          outcome: "recovery-required",
          result: {
            kind: "doctor", ...environmentResult(environment),
            transactionState: "document",
            protocolKind: "document-authoring",
            foundationVersion: inspection.foundationVersion,
            foundationBuildIdentity: inspection.foundationBuildIdentity,
            recoveryClass: "auto-recoverable",
            recoveryCommand: {
              commandId: "docs.recover",
              args: {
                consumerRoot: request.consumerRoot,
                exactFoundationVersion: inspection.recovery.exactFoundationVersion,
                exactFoundationBuildIdentity: inspection.recovery.exactFoundationBuildIdentity
              }
            }
          }
        });
      }
      const exactRecovery = inspection.recovery;
      return commandExecution({
        command: "docs.doctor",
        diagnostics: inspectionDiagnostics(inspection, request.consumerRoot),
        outcome: "recovery-required",
        result: {
          kind: "doctor",
          ...environmentResult(environment),
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
                args: { ...exactRecovery.args, consumerRoot: request.consumerRoot }
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
          kind: "doctor",
          ...(environment === undefined ? {} : environmentResult(environment)),
          transactionState: "unknown", protocolKind: "unknown",
          recoveryClass: "manual"
        }
      });
    }
  }
}

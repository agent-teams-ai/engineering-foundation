import type {
  DocumentCommandDiagnostic,
  DocumentCommandExecution,
  DocumentRecoverResult
} from "../model/document-command.js";
import type { DocumentReceiptContract as DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentTransactionInspection } from "../model/document-transaction-inspection.js";
import {
  commandExecution,
  projectDocumentCommandFailure,
  receiptOutcome
} from "../policies/document-command-projection.js";
import { projectDocumentCommandConsumerRoot } from "../policies/document-command-consumer-root.js";

export interface RunDocumentRecoverRequest {
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}

interface Dependencies {
  inspect(consumerRoot: string): Promise<DocumentTransactionInspection>;
  recover(request: {
    readonly consumerRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentReceipt>;
}

function manualDiagnostics(
  inspection: Extract<DocumentTransactionInspection, {
    readonly state: "manual-recovery-required";
  }>,
  consumerRoot: string
): readonly DocumentCommandDiagnostic[] {
  return inspection.diagnostics.map((entry) => ({
    ruleId: entry.code.toLowerCase().replaceAll("_", "."),
    severity: "error" as const,
    phase: "recovery" as const,
    subject: "document.transaction",
    message: entry.message,
    ...(inspection.recovery === undefined
      ? {}
      : { remediation: {
          commandId: inspection.recovery.commandId === "docs-recover"
            ? "docs.recover" as const : inspection.recovery.commandId,
          args: {
            ...inspection.recovery.args,
            consumerRoot: projectDocumentCommandConsumerRoot(consumerRoot)
          }
        } })
  }));
}

function writeState(receipt: DocumentReceipt): DocumentRecoverResult["writeState"] {
  switch (receipt.commit.publication) {
    case "published": return "committed";
    case "preexisting-exact": return "already-committed";
    case "none": return "unchanged";
    case "unknown": return "unknown";
  }
}

function recoveryState(
  receipt: DocumentReceipt
): DocumentRecoverResult["transactionState"] {
  switch (receipt.outcome) {
    case "applied": return "recovered";
    case "already-applied": return "already-applied";
    case "cancelled": return "cancelled";
    case "recovery-required": return "recovery-required";
    case "manual-recovery-required": return "manual-required";
    case "authority-stale":
    case "failed-before-publication":
    case "rejected": return "failed";
  }
}

export class RunDocumentRecover {
  readonly #dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async execute(
    request: RunDocumentRecoverRequest
  ): Promise<DocumentCommandExecution<DocumentRecoverResult>> {
    try {
      request.signal?.throwIfAborted();
      const inspection = await this.#dependencies.inspect(request.consumerRoot);
      request.signal?.throwIfAborted();
      if (inspection.state === "idle") {
        return commandExecution({
          command: "docs.recover", outcome: "success",
          result: {
            kind: "recover", transactionState: "no-pending-transaction",
            writeState: "unchanged", recoveryRequired: false
          }
        });
      }
      if (inspection.state === "manual-recovery-required") {
        return commandExecution({
          command: "docs.recover",
          diagnostics: manualDiagnostics(inspection, request.consumerRoot),
          outcome: "recovery-required",
          result: {
            kind: "recover", transactionState: "manual-required",
            writeState: "unknown", recoveryRequired: true,
            ...(inspection.recovery === undefined
              ? {}
              : { recoveryCommand: {
                  commandId: inspection.recovery.commandId === "docs-recover"
                    ? "docs.recover" as const : inspection.recovery.commandId,
                  args: {
                    ...inspection.recovery.args,
                    consumerRoot: projectDocumentCommandConsumerRoot(request.consumerRoot)
                  }
                } })
          }
        });
      }
      const receipt = await this.#dependencies.recover({
        consumerRoot: request.consumerRoot,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      const outcome = receiptOutcome(receipt);
      return commandExecution({
        command: "docs.recover",
        diagnostics: receipt.diagnostics.map((entry) => ({
          ...entry,
          ...(outcome === "recovery-required"
            ? { remediation: {
                commandId: "docs.doctor" as const,
                args: {
                  consumerRoot: projectDocumentCommandConsumerRoot(request.consumerRoot)
                }
              } }
            : {})
        })),
        outcome,
        result: {
          kind: "recover",
          transactionState: recoveryState(receipt),
          writeState: writeState(receipt),
          recoveryRequired: outcome === "recovery-required",
          receiptDigest: receipt.receiptDigest
        }
      });
    } catch (error) {
      const failure = projectDocumentCommandFailure({
        command: "docs.recover", error, phase: "recovery", subject: "document.transaction"
      });
      return commandExecution({
        command: "docs.recover", diagnostics: [failure.diagnostic], outcome: failure.outcome,
        result: {
          kind: "recover",
          transactionState: failure.outcome === "cancelled" ? "cancelled" : "failed",
          writeState: "unknown",
          recoveryRequired: false
        }
      });
    }
  }
}

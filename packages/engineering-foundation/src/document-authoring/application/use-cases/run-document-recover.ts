import type {
  DocumentCommandDiagnostic,
  DocumentCommandExecution,
  DocumentRecoverResult
} from "../model/document-command.js";
import type { DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentTransactionInspectionV1 } from "../model/document-transaction-inspection.js";
import {
  commandExecution,
  projectDocumentCommandFailure,
  receiptOutcome
} from "../policies/document-command-projection.js";

export interface RunDocumentRecoverRequest {
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}

interface Dependencies {
  inspect(consumerRoot: string): Promise<DocumentTransactionInspectionV1>;
  recover(request: {
    readonly consumerRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentReceipt>;
}

function manualDiagnostics(
  inspection: Extract<DocumentTransactionInspectionV1, {
    readonly state: "manual-recovery-required";
  }>
): readonly DocumentCommandDiagnostic[] {
  return inspection.diagnostics.map((entry) => ({
    ruleId: entry.code.toLowerCase().replaceAll("_", "."),
    severity: "error" as const,
    phase: "recovery" as const,
    subject: "document.transaction",
    message: entry.message
  }));
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
          result: { kind: "recover", transactionState: "no-pending-transaction" }
        });
      }
      if (inspection.state === "manual-recovery-required") {
        return commandExecution({
          command: "docs.recover", diagnostics: manualDiagnostics(inspection),
          outcome: "recovery-required",
          result: { kind: "recover", transactionState: "manual-required" }
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
            ? { remediation: { commandId: "docs.doctor" as const, args: {} } }
            : {})
        })),
        outcome,
        result: {
          kind: "recover",
          transactionState: receipt.outcome === "already-applied"
            ? "already-applied"
            : receipt.outcome === "applied"
              ? "recovered"
              : "manual-required",
          receiptDigest: receipt.receiptDigest
        }
      });
    } catch (error) {
      const failure = projectDocumentCommandFailure({
        command: "docs.recover", error, phase: "recovery", subject: "document.transaction"
      });
      return commandExecution({
        command: "docs.recover", diagnostics: [failure.diagnostic], outcome: failure.outcome,
        result: { kind: "recover", transactionState: "manual-required" }
      });
    }
  }
}

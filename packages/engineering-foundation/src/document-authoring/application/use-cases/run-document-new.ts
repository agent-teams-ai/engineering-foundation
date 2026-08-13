import type {
  DocumentCommandDiagnostic,
  DocumentCommandExecution,
  DocumentNewResult
} from "../model/document-command.js";
import type { DocumentPlan } from "../model/document-planning.js";
import type { DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentTransactionInspectionV1 } from "../model/document-transaction-inspection.js";
import type { DocumentReachabilityProjector } from "../ports/document-reachability-projector.js";
import type { DocumentStructureVerifier } from "../ports/document-structure-verifier.js";
import type { SimilarDocumentAdvisor } from "../ports/similar-document-advisor.js";
import type { PlanDocumentationDocumentRequest } from "./plan-documentation-document.js";
import {
  commandExecution,
  projectDocumentCommandFailure,
  receiptOutcome
} from "../policies/document-command-projection.js";
import { projectSimilarDocumentAdvice } from "../policies/project-similar-document-advice.js";

export interface RunDocumentNewRequest extends PlanDocumentationDocumentRequest {
  readonly dryRun: boolean;
}

interface Dependencies {
  apply(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<DocumentReceipt>;
  inspect(consumerRoot: string): Promise<DocumentTransactionInspectionV1>;
  plan(request: PlanDocumentationDocumentRequest): Promise<DocumentPlan>;
  readonly similar: SimilarDocumentAdvisor;
  readonly reachability: DocumentReachabilityProjector;
  readonly structure: DocumentStructureVerifier;
}

function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function transactionDiagnostic(
  inspection: Exclude<DocumentTransactionInspectionV1, { readonly state: "idle" }>
): DocumentCommandDiagnostic {
  const recovery = inspection.state === "recoverable"
    ? { commandId: "docs.recover" as const, args: {} }
    : inspection.recovery === undefined
      ? undefined
      : {
          commandId: inspection.recovery.commandId === "docs-recover"
            ? "docs.recover" as const : inspection.recovery.commandId,
          args: inspection.recovery.args,
        };
  return {
    ruleId: "document.new.transaction-active",
    severity: "error",
    phase: "recovery",
    subject: "document.transaction",
    message: inspection.state === "recoverable"
      ? "A recoverable Foundation document transaction must be completed first."
      : inspection.reason,
    ...(recovery === undefined ? {} : { remediation: recovery }),
  };
}

function receiptDiagnostics(receipt: DocumentReceipt): readonly DocumentCommandDiagnostic[] {
  return receipt.diagnostics.map((entry) => ({
    ...entry,
    ...(receipt.outcome === "recovery-required" ||
      receipt.outcome === "manual-recovery-required"
      ? { remediation: { commandId: "docs.recover" as const, args: {} } }
      : {})
  }));
}

async function similarDocumentDiagnostics(input: {
  readonly dependencies: Pick<Dependencies, "similar">;
  readonly consumerRoot: string;
  readonly plan: DocumentPlan;
  readonly signal?: AbortSignal;
}): Promise<readonly DocumentCommandDiagnostic[]> {
  try {
    const advice = await input.dependencies.similar.advise({
      consumerRoot: input.consumerRoot,
      profilePath: input.plan.authority.profile.path,
      title: input.plan.intent.title,
      ...signalOption(input.signal),
    });
    return projectSimilarDocumentAdvice(advice);
  } catch (error) {
    input.signal?.throwIfAborted();
    throw error;
  }
}

export class RunDocumentNew {
  readonly #dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async execute(
    request: RunDocumentNewRequest
  ): Promise<DocumentCommandExecution<DocumentNewResult>> {
    let publicationCommitted = false;
    let committedDocumentPath: string | undefined;
    let committedWriteState: "already-applied" | "applied" | undefined;
    let projectedReachability: Awaited<ReturnType<
      DocumentReachabilityProjector["project"]
    >> | undefined;
    let advisoryDiagnostics: readonly DocumentCommandDiagnostic[] = [];
    try {
      request.signal?.throwIfAborted();
      const inspection = await this.#dependencies.inspect(request.consumerRoot);
      request.signal?.throwIfAborted();
      if (inspection.state !== "idle") {
        return commandExecution({
          command: "docs.new",
          diagnostics: [transactionDiagnostic(inspection)],
          outcome: "recovery-required",
          result: { kind: "new", reservation: "none" }
        });
      }
      const plan = await this.#dependencies.plan({
        consumerRoot: request.consumerRoot,
        profilePath: request.profilePath,
        intent: request.intent,
        ...signalOption(request.signal)
      });
      advisoryDiagnostics = await similarDocumentDiagnostics({
        dependencies: this.#dependencies,
        consumerRoot: request.consumerRoot,
        plan,
        ...signalOption(request.signal),
      });
      request.signal?.throwIfAborted();
      const reachability = await this.#dependencies.reachability.project({
        consumerRoot: request.consumerRoot,
        plan
      });
      projectedReachability = reachability;
      request.signal?.throwIfAborted();
      if (request.dryRun) {
        return commandExecution({
          command: "docs.new",
          diagnostics: advisoryDiagnostics,
          outcome: "success",
          result: {
            kind: "new",
            documentPath: plan.destination,
            writeState: "preview",
            reservation: "none",
            reachability
          }
        });
      }
      const receipt = await this.#dependencies.apply({
        consumerRoot: request.consumerRoot,
        plan,
        ...signalOption(request.signal)
      });
      const outcome = receiptOutcome(receipt);
      publicationCommitted = receipt.outcome === "applied" ||
        receipt.outcome === "already-applied";
      if (publicationCommitted) {
        committedDocumentPath = plan.destination;
        committedWriteState = receipt.outcome === "already-applied"
          ? "already-applied" : "applied";
      }
      if (outcome !== "success") {
        return commandExecution({
          command: "docs.new",
          diagnostics: [...advisoryDiagnostics, ...receiptDiagnostics(receipt)],
          outcome,
          result: {
            kind: "new",
            documentPath: plan.destination,
            reservation: "none",
            receiptOutcome: receipt.outcome,
            reachability
          }
        });
      }
      const verification = await this.#dependencies.structure.verify({
        consumerRoot: request.consumerRoot,
        plan,
        ...signalOption(request.signal)
      });
      const diagnostics: readonly DocumentCommandDiagnostic[] = [
        ...advisoryDiagnostics,
        ...receiptDiagnostics(receipt),
        ...verification.diagnostics.map((entry) => ({
          ...entry,
          phase: "apply" as const,
          severity: "error" as const
        }))
      ];
      return commandExecution({
        command: "docs.new",
        diagnostics,
        outcome: verification.valid ? "success" : "violation",
        result: {
          kind: "new",
          documentPath: plan.destination,
          writeState: receipt.outcome === "already-applied"
            ? "already-applied" : "applied",
          reservation: "none",
          receiptOutcome: receipt.outcome,
          reachability
        }
      });
    } catch (error) {
      if (publicationCommitted) {
        return commandExecution({
          command: "docs.new",
          diagnostics: [...advisoryDiagnostics, {
            ruleId: "document.new.post-publication-verification",
            severity: "error",
            phase: "apply",
            subject: "document.new",
            message: "The document was published, but post-publication structural verification failed. The created output was preserved."
          }],
          outcome: "violation",
          result: {
            kind: "new",
            ...(committedDocumentPath === undefined
              ? {} : { documentPath: committedDocumentPath }),
            ...(committedWriteState === undefined
              ? {} : { writeState: committedWriteState }),
            ...(projectedReachability === undefined
              ? {} : { reachability: projectedReachability }),
            reservation: "none"
          }
        });
      }
      const failure = projectDocumentCommandFailure({
        command: "docs.new", error, phase: "planning", subject: "document.new",
        allowCancellation: true
      });
      return commandExecution({
        command: "docs.new",
        diagnostics: [...advisoryDiagnostics, failure.diagnostic],
        outcome: failure.outcome,
        result: { kind: "new", reservation: "none" }
      });
    }
  }
}

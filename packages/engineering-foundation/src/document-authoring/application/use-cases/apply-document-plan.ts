import type { DocumentPlan } from "../model/document-planning.js";
import type { DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentContractValidator } from "../ports/document-contract-validator.js";
import type { DocumentTransactionCoordinator } from "../ports/document-transaction-coordinator.js";
import {
  continuePendingPublication,
  createPreparedJournal,
  errorMessage,
  finalizeDocumentTransaction,
  isCancellation,
  noPublicationReceipt,
  recoveryReceipt,
  type ActiveDocumentJournal,
  type DocumentTransactionRuntime
} from "./document-transaction-continuation.js";
import type { DocumentOwnedTemporary } from "../model/document-transaction.js";
import { DocumentTransactionUseCaseError } from "./document-transaction-error.js";

export interface ApplyDocumentPlanDependencies extends DocumentTransactionRuntime {
  readonly contractValidator: DocumentContractValidator;
  readonly coordinator: DocumentTransactionCoordinator;
}

export interface ApplyDocumentPlanRequest {
  readonly consumerRoot: string;
  readonly plan: unknown;
  readonly signal?: AbortSignal;
}

function signalOption(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

async function safelyCancelBeforePublication(
  dependencies: ApplyDocumentPlanDependencies,
  input: {
    readonly active?: ActiveDocumentJournal;
    readonly failure: unknown;
    readonly outcome: "cancelled" | "failed-before-publication";
    readonly plan: DocumentPlan;
    readonly request: ApplyDocumentPlanRequest;
    readonly temporary?: DocumentOwnedTemporary;
  }
): Promise<DocumentReceipt> {
  const { active, failure, outcome, plan, request, temporary } = input;
  try {
    const destination = await dependencies.fileState.classifyDestination({
      consumerRoot: request.consumerRoot,
      plan
    });
    if (destination.state !== "absent") {
      throw new Error(`Destination is ${destination.state}; publication absence is unproven.`);
    }
    if (temporary !== undefined) {
      const state = await dependencies.fileState.classifyTemporary({
        consumerRoot: request.consumerRoot,
        temporary
      });
      if (state.state === "owned-exact") {
        await dependencies.publisher.removeOwnedTemporary({
          consumerRoot: request.consumerRoot,
          temporary
        });
      } else if (state.state !== "absent") {
        throw new Error("Owned temporary changed and cannot be removed safely.");
      }
    } else {
      const derived = await dependencies.fileState.classifyDerivedTemporary({
        consumerRoot: request.consumerRoot,
        plan
      });
      if (derived.state !== "absent") {
        throw new Error(
          "Plan-derived temporary may exist without trusted ownership evidence."
        );
      }
    }
    if (active !== undefined) {
      await dependencies.journal.remove(active.identity);
    }
    return noPublicationReceipt(
      plan,
      outcome,
      outcome === "cancelled"
        ? "document.transaction.cancelled"
        : "document.transaction.failed-before-publication",
      errorMessage(failure)
    );
  } catch (cleanupError) {
    return recoveryReceipt(plan, {
      message: `Prepublication cleanup could not prove an empty durable state: ${errorMessage(cleanupError)}`,
      publication: "unknown",
      ruleId: "document.transaction.cleanup-unproven"
    });
  }
}

/** Applies one validated create-only Plan through the durable writer protocol. */
export async function applyDocumentPlan(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest
): Promise<DocumentReceipt> {
  // Calling the validator is intentionally the first operation. The Node
  // implementation snapshots and rejects hostile in-memory Plans synchronously
  // before its first await.
  const plan = await dependencies.contractValidator.validatePlan(request.plan);
  request.signal?.throwIfAborted();
  const lease = await dependencies.coordinator.acquire({ mode: "apply" });
  let retainBarrier = true;
  let active: ActiveDocumentJournal | undefined;
  let temporary: DocumentOwnedTemporary | undefined;
  let publicationPossible = false;
  try {
    if (lease.status.state !== "idle") {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_COORDINATION_FAILED",
        "Document apply requires an idle transaction coordinator."
      );
    }
    if (await dependencies.journal.read() !== undefined) {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_INCONSISTENT",
        "Coordinator reported idle while a document journal exists."
      );
    }
    const derived = await dependencies.fileState.classifyDerivedTemporary({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    });
    if (derived.state !== "absent") {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
        `Plan-derived temporary is ${derived.state}; evidence was preserved.`
      );
    }
    const authority = await dependencies.authority.assess({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    });
    if (authority.state !== "current") {
      retainBarrier = false;
      return noPublicationReceipt(
        plan,
        "authority-stale",
        "document.transaction.authority-stale",
        authority.reason,
        "authority"
      );
    }
    const destination = await dependencies.fileState.classifyDestination({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    });
    if (destination.state === "conflict" || destination.state === "unverifiable") {
      retainBarrier = false;
      return noPublicationReceipt(
        plan,
        "rejected",
        "document.transaction.destination-conflict",
        destination.reason
      );
    }
    if (destination.state === "exact") {
      active = await createPreparedJournal(dependencies, plan, "preexisting");
      const receipt = await finalizeDocumentTransaction(
        dependencies,
        request,
        active,
        "already-applied"
      );
      if (receipt === undefined) {
        return recoveryReceipt(plan, {
          message: "Preexisting exact output failed stable A1-C1-A2-C2 verification.",
          publication: "none",
          ruleId: "document.transaction.final-verification"
        });
      }
      retainBarrier = false;
      return receipt;
    }
    active = await createPreparedJournal(dependencies, plan, "pending");
    temporary = await dependencies.publisher.prepare({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    });
    // The helper advances the journal before the publication call. From entry,
    // an adapter failure may mean publication occurred, so cleanup is forbidden.
    publicationPossible = true;
    const receipt = await continuePendingPublication(
      dependencies,
      request,
      active,
      temporary
    );
    retainBarrier = receipt.outcome !== "applied";
    return receipt;
  } catch (error) {
    if (!publicationPossible) {
      const receipt = await safelyCancelBeforePublication(dependencies, {
        ...(active === undefined ? {} : { active }),
        failure: error,
        outcome: isCancellation(error, request.signal)
          ? "cancelled"
          : "failed-before-publication",
        plan,
        request,
        ...(temporary === undefined ? {} : { temporary })
      });
      retainBarrier = receipt.outcome === "recovery-required" ||
        receipt.outcome === "manual-recovery-required";
      return receipt;
    }
    return recoveryReceipt(plan, {
      message: `Publication may have occurred; output and evidence were preserved: ${errorMessage(error)}`,
      publication: "unknown",
      ruleId: "document.transaction.publication-ambiguous"
    });
  } finally {
    await lease.release({ retainTransactionBarrier: retainBarrier });
  }
}

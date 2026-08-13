import type { DocumentPlan } from "../model/document-planning.js";
import type { DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentContractValidator } from "../ports/document-contract-validator.js";
import type { DocumentTransactionCoordinator } from "../ports/document-transaction-coordinator.js";
import {
  continuePendingPublication,
  createPreparedJournal,
  DocumentJournalReconciliationError,
  errorMessage,
  finalizeDocumentTransaction,
  isCancellation,
  noPublicationReceipt,
  removeJournalReconciled,
  recoveryReceipt,
  type ActiveDocumentJournal,
  type DocumentTransactionRuntime
} from "./document-transaction-continuation.js";
import type { DocumentOwnedTemporary } from "../model/document-transaction.js";
import { DocumentTransactionUseCaseError } from "./document-transaction-error.js";
import {
  executeWithDocumentTransactionLease,
  type DocumentTransactionExecution
} from "./document-transaction-execution.js";

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
      await removeJournalReconciled(dependencies, active);
    }
    const finalJournal = await dependencies.journal.read();
    const finalDestination = await dependencies.fileState.classifyDestination({
      consumerRoot: request.consumerRoot,
      plan
    });
    const finalTemporary = await dependencies.fileState.classifyDerivedTemporary({
      consumerRoot: request.consumerRoot,
      plan
    });
    if (finalJournal !== undefined || finalTemporary.state !== "absent") {
      throw new Error(
        "Final prepublication proof did not establish absent temporary and journal."
      );
    }
    if (finalDestination.state === "unverifiable") {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
        `Final destination evidence is unavailable: ${finalDestination.reason}`
      );
    }
    if (finalDestination.state !== "absent") {
      return noPublicationReceipt(
        plan,
        "rejected",
        "document.transaction.destination-raced",
        finalDestination.state === "exact"
          ? "Destination appeared after Foundation evidence cleanup."
          : finalDestination.reason
      );
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
    if (cleanupError instanceof DocumentTransactionUseCaseError &&
      cleanupError.code === "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE") {
      throw cleanupError;
    }
    return recoveryReceipt(plan, {
      message: `Prepublication cleanup could not prove an empty durable state: ${errorMessage(cleanupError)}`,
      publication: "unknown",
      ruleId: "document.transaction.cleanup-unproven"
    });
  }
}

interface ApplyExecutionState {
  active?: ActiveDocumentJournal;
  publicationPossible: boolean;
  retainTransactionBarrier: boolean;
  temporary?: DocumentOwnedTemporary;
}

async function runApplyTransaction(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest,
  plan: DocumentPlan,
  state: ApplyExecutionState
): Promise<DocumentReceipt> {
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
  request.signal?.throwIfAborted();
  if (authority.state !== "current") {
    state.retainTransactionBarrier = false;
    return noPublicationReceipt(plan, "authority-stale",
      "document.transaction.authority-stale", authority.reason, "authority");
  }
  const destination = await dependencies.fileState.classifyDestination({
    consumerRoot: request.consumerRoot,
    plan,
    ...signalOption(request.signal)
  });
  if (destination.state === "conflict" || destination.state === "unverifiable") {
    state.retainTransactionBarrier = false;
    return noPublicationReceipt(plan, "rejected",
      "document.transaction.destination-conflict", destination.reason);
  }
  if (destination.state === "exact") {
    state.active = await createPreparedJournal(dependencies, plan, "preexisting");
    const receipt = await finalizeDocumentTransaction(
      dependencies, request, state.active, "already-applied"
    );
    if (receipt === undefined) {
      return recoveryReceipt(plan, {
        message: "Preexisting exact output failed stable A1-C1-A2-C2 verification.",
        publication: "none",
        ruleId: "document.transaction.final-verification"
      });
    }
    state.retainTransactionBarrier = false;
    return receipt;
  }
  state.active = await createPreparedJournal(dependencies, plan, "pending");
  request.signal?.throwIfAborted();
  state.temporary = await dependencies.publisher.prepare({
    consumerRoot: request.consumerRoot,
    plan,
    ...signalOption(request.signal)
  });
  request.signal?.throwIfAborted();
  const receipt = await continuePendingPublication(
    dependencies,
    request,
    state.active,
    state.temporary,
    () => {
      state.publicationPossible = true;
    }
  );
  state.retainTransactionBarrier = receipt.outcome !== "applied";
  return receipt;
}

async function handleApplyFailure(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest,
  plan: DocumentPlan,
  state: ApplyExecutionState,
  error: unknown
): Promise<DocumentReceipt> {
  let journalVerifiable = true;
  try {
    await dependencies.journal.read();
  } catch {
    journalVerifiable = false;
  }
  if (!journalVerifiable || error instanceof DocumentJournalReconciliationError ||
    (error instanceof Error && error.name === "DocumentJournalReconciliationError")) {
    state.retainTransactionBarrier = true;
    return recoveryReceipt(plan, {
      manual: true,
      message: `Journal mutation is not reconcilable; all evidence was preserved: ${errorMessage(error)}`,
      publication: state.publicationPossible ? "unknown" : "none",
      ruleId: "document.transaction.journal-reconciliation"
    });
  }
  if (!state.publicationPossible) {
    const receipt = await safelyCancelBeforePublication(dependencies, {
      ...(state.active === undefined ? {} : { active: state.active }),
      failure: error,
      outcome: isCancellation(error, request.signal)
        ? "cancelled" : "failed-before-publication",
      plan,
      request,
      ...(state.temporary === undefined ? {} : { temporary: state.temporary })
    });
    state.retainTransactionBarrier = receipt.outcome === "recovery-required" ||
      receipt.outcome === "manual-recovery-required";
    return receipt;
  }
  return recoveryReceipt(plan, {
    message: `Publication may have occurred; output and evidence were preserved: ${errorMessage(error)}`,
    publication: "unknown",
    ruleId: "document.transaction.publication-ambiguous"
  });
}

async function executeApply(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest,
  plan: DocumentPlan,
  coordinatorIdle: boolean
): Promise<DocumentTransactionExecution<DocumentReceipt>> {
  const state: ApplyExecutionState = {
    publicationPossible: false,
    retainTransactionBarrier: true
  };
  try {
    if (!coordinatorIdle) {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_COORDINATION_FAILED",
        "Document apply requires an idle transaction coordinator."
      );
    }
    const value = await runApplyTransaction(dependencies, request, plan, state);
    return { retainTransactionBarrier: state.retainTransactionBarrier, value };
  } catch (error) {
    const value = await handleApplyFailure(dependencies, request, plan, state, error);
    const primaryFailure = error instanceof Error && error.cause instanceof AggregateError
      ? error.cause : error;
    return {
      primaryFailure,
      retainTransactionBarrier: state.retainTransactionBarrier,
      value
    };
  }
}

/** Applies one validated create-only Plan through the durable writer protocol. */
export async function applyDocumentPlan(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest
): Promise<DocumentReceipt> {
  // Validation remains the first operation so hostile in-memory Plans are
  // snapshotted synchronously by the Node validator before its first await.
  const plan = await dependencies.contractValidator.validatePlan(request.plan);
  if (request.signal?.aborted === true) {
    return noPublicationReceipt(plan, "cancelled", "document.transaction.cancelled",
      "Document transaction was cancelled before coordination.");
  }
  const lease = await dependencies.coordinator.acquire({ mode: "apply" });
  return executeWithDocumentTransactionLease(
    lease,
    async () => executeApply(
      dependencies, request, plan, lease.status.state === "idle"
    ),
    "Document apply and transaction lease release both failed."
  );
}

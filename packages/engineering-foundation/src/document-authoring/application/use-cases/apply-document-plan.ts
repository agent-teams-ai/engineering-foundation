import type { DocumentPlanContract as DocumentPlan } from "../model/document-planning.js";
import type { DocumentReceiptContract as DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentContractValidator } from "../ports/document-contract-validator.js";
import type { DocumentTransactionCoordinator } from "../ports/document-transaction-coordinator.js";
import {
  continuePendingPublication,
  createPreparedJournal,
  DocumentJournalReconciliationError,
  errorMessage,
  finalizeDocumentTransaction,
  isCancellation,
  materializeDocumentParentDirectories,
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
import {
  directoryReceiptEvidence,
  type DocumentDirectoryReceiptEvidence
} from "./document-transaction-receipts.js";
import {
  applyRecoveryReceipt,
  type ApplyExecutionState
} from "./apply-document-recovery-receipt.js";

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

async function recaptureRetainedDirectoryReceiptEvidence(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest,
  active: ActiveDocumentJournal | undefined
): Promise<DocumentDirectoryReceiptEvidence | undefined> {
  if (active?.envelope.schemaVersion !== 4) {
    return undefined;
  }
  const inspection = await dependencies.parentMaterializer.inspect({
    consumerRoot: request.consumerRoot,
    journal: {
      anchorIdentity: active.envelope.journal.parentMaterialization.anchorIdentity,
      createdDirectories: active.envelope.journal.parentMaterialization.createdDirectories,
      plan: active.envelope.journal.plan.parentMaterialization,
      schemaVersion: 2
    }
  });
  if (inspection.state !== "current") {
    throw new Error(`Retained directory evidence is unsafe: ${inspection.reason}.`);
  }
  const initial = directoryReceiptEvidence(active.envelope);
  if (initial === undefined) {
    throw new Error("Envelope v4 did not provide directory materialization evidence.");
  }
  if (initial.state === "preserved-unknown") {
    throw new Error(
      "Directory creation may have crossed mkdir before durable identity binding."
    );
  }
  return {
    observedCreatedDirectories: initial.observedCreatedDirectories,
    state: initial.observedCreatedDirectories.length === 0
      ? "none-created"
      : "created-and-retained"
  };
}

async function cleanPrepublicationTemporary(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest,
  plan: DocumentPlan,
  temporary: DocumentOwnedTemporary | undefined,
  active: ActiveDocumentJournal | undefined
): Promise<void> {
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
    return;
  }
  const derived = await dependencies.fileState.classifyDerivedTemporary({
    consumerRoot: request.consumerRoot,
    plan
  });
  const exactMissingParent = derived.state === "unverifiable" &&
    await hasExactlyObservedMissingParent(dependencies, request, active);
  if (derived.state !== "absent" &&
    !exactMissingParent) {
    throw new Error("Plan-derived temporary may exist without trusted ownership evidence.");
  }
}

async function hasExactlyObservedMissingParent(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest,
  active: ActiveDocumentJournal | undefined
): Promise<boolean> {
  if (active?.envelope.schemaVersion !== 4) {
    return false;
  }
  const inspection = await dependencies.parentMaterializer.inspect({
    consumerRoot: request.consumerRoot,
    journal: {
      anchorIdentity: active.envelope.journal.parentMaterialization.anchorIdentity,
      createdDirectories: active.envelope.journal.parentMaterialization.createdDirectories,
      plan: active.envelope.journal.plan.parentMaterialization,
      schemaVersion: 2
    }
  });
  if (inspection.state !== "current") {
    throw new Error(`Retained directory evidence is unsafe: ${inspection.reason}.`);
  }
  return inspection.nextDirectory !== undefined;
}

async function isExactMissingParentObservation(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest,
  active: ActiveDocumentJournal | undefined,
  destinationState: string,
  temporaryState?: string
): Promise<boolean> {
  if (destinationState !== "unverifiable" ||
    (temporaryState !== undefined && temporaryState !== "unverifiable")) {
    return false;
  }
  return hasExactlyObservedMissingParent(dependencies, request, active);
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
): Promise<{
  readonly cleanupFailure?: unknown;
  readonly receipt: DocumentReceipt;
}> {
  const { active, failure, outcome, plan, request, temporary } = input;
  const initialDirectoryEvidence = active === undefined
    ? undefined
    : directoryReceiptEvidence(active.envelope);
  try {
    const destination = await dependencies.fileState.classifyDestination({
      consumerRoot: request.consumerRoot,
      plan
    });
    const retainedMissingParent = await isExactMissingParentObservation(
      dependencies, request, active, destination.state
    );
    if (destination.state !== "absent" && !retainedMissingParent) {
      throw new Error(`Destination is ${destination.state}; publication absence is unproven.`);
    }
    await cleanPrepublicationTemporary(
      dependencies, request, plan, temporary, active
    );
    // This recapture is intentionally adjacent to journal removal: a stale
    // identity must retain the durable recovery barrier and cannot be reported
    // as created-and-retained.
    const directoryEvidence = await recaptureRetainedDirectoryReceiptEvidence(
      dependencies, request, active
    );
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
    const v2MissingParent = await isExactMissingParentObservation(
      dependencies, request, active,
      finalDestination.state, finalTemporary.state
    );
    if (finalJournal !== undefined ||
      (finalTemporary.state !== "absent" && !v2MissingParent)) {
      throw new Error(
        "Final prepublication proof did not establish absent temporary and journal."
      );
    }
    if (finalDestination.state === "unverifiable" && !v2MissingParent) {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
        `Final destination evidence is unavailable: ${finalDestination.reason}`
      );
    }
    if (finalDestination.state !== "absent" && !v2MissingParent) {
      return { receipt: await noPublicationReceipt(
        plan,
        "rejected",
        "document.transaction.destination-raced",
        finalDestination.state === "exact"
          ? "Destination appeared after Foundation evidence cleanup."
          : finalDestination.reason,
        directoryEvidence === undefined ? {} : { directoryEvidence }
      ) };
    }
    return { receipt: await noPublicationReceipt(
      plan,
      outcome,
      outcome === "cancelled"
        ? "document.transaction.cancelled"
        : "document.transaction.failed-before-publication",
      errorMessage(failure),
      directoryEvidence === undefined ? {} : { directoryEvidence }
    ) };
  } catch (cleanupError) {
    return {
      cleanupFailure: cleanupError,
      receipt: await recoveryReceipt(plan, {
      ...(initialDirectoryEvidence === undefined
        ? {}
        : { directoryEvidence: {
            observedCreatedDirectories:
              initialDirectoryEvidence.observedCreatedDirectories,
            state: "preserved-unknown" as const
          } }),
      manual: true,
      message: `Prepublication cleanup could not prove an empty durable state: ${errorMessage(cleanupError)} Original operation failure: ${errorMessage(failure)}`,
      publication: "unknown",
      ruleId: "document.transaction.cleanup-unproven"
      })
    };
  }
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
  if (plan.schemaVersion === 1) {
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
      "document.transaction.authority-stale", authority.reason, { phase: "authority" });
  }
  const observedDestination = await dependencies.fileState.classifyDestination({
    consumerRoot: request.consumerRoot,
    plan,
    ...signalOption(request.signal)
  });
  const destination = plan.schemaVersion === 2 &&
      plan.parentMaterialization.missingDirectories.length > 0 &&
      observedDestination.state === "unverifiable"
    ? { state: "absent" as const }
    : observedDestination;
  if (destination.state === "conflict" || destination.state === "unverifiable") {
    state.retainTransactionBarrier = false;
    return noPublicationReceipt(plan, "rejected",
      "document.transaction.destination-conflict", destination.reason);
  }
  if (destination.state === "exact") {
    state.active = await createPreparedJournal(
      dependencies, request.consumerRoot, plan, "preexisting"
    );
    const receipt = await finalizeDocumentTransaction(
      dependencies, request, state.active, "already-applied"
    );
    if (receipt === undefined) {
      return applyRecoveryReceipt(dependencies, request, plan, state, {
        message: "Preexisting exact output failed stable A1-C1-A2-C2 verification.",
        publication: "none",
        ruleId: "document.transaction.final-verification"
      });
    }
    state.retainTransactionBarrier = false;
    return receipt;
  }
  state.active = await createPreparedJournal(
    dependencies, request.consumerRoot, plan, "pending"
  );
  state.active = await materializeDocumentParentDirectories(
    dependencies,
    request,
    state.active,
    (active) => { state.active = active; }
  );
  const derivedAfterMaterialization =
    await dependencies.fileState.classifyDerivedTemporary({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    });
  if (derivedAfterMaterialization.state !== "absent") {
    throw new DocumentTransactionUseCaseError(
      "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
      `Plan-derived temporary is ${derivedAfterMaterialization.state}; evidence was preserved.`
    );
  }
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
): Promise<{
  readonly cleanupFailure?: unknown;
  readonly receipt: DocumentReceipt;
}> {
  let journalVerifiable = true;
  try {
    await dependencies.journal.read();
  } catch {
    journalVerifiable = false;
  }
  if (!journalVerifiable || error instanceof DocumentJournalReconciliationError ||
    (error instanceof Error && error.name === "DocumentJournalReconciliationError")) {
    state.retainTransactionBarrier = true;
    const receipt = await applyRecoveryReceipt(
      dependencies, request, plan, state, {
        manual: true,
        message: `Journal mutation is not reconcilable; all evidence was preserved: ${errorMessage(error)}`,
        publication: state.publicationPossible ? "unknown" : "none",
        ruleId: "document.transaction.journal-reconciliation"
      }
    );
    return { receipt };
  }
  if (!state.publicationPossible) {
    const handled = await safelyCancelBeforePublication(dependencies, {
      ...(state.active === undefined ? {} : { active: state.active }),
      failure: error,
      outcome: isCancellation(error, request.signal)
        ? "cancelled" : "failed-before-publication",
      plan,
      request,
      ...(state.temporary === undefined ? {} : { temporary: state.temporary })
    });
    state.retainTransactionBarrier = handled.receipt.outcome === "recovery-required" ||
      handled.receipt.outcome === "manual-recovery-required";
    return handled;
  }
  const receipt = await applyRecoveryReceipt(
    dependencies, request, plan, state, {
      message: `Publication may have occurred; output and evidence were preserved: ${errorMessage(error)}`,
      publication: "unknown",
      ruleId: "document.transaction.publication-ambiguous"
    }
  );
  return { receipt };
}

function applyFailureEvidence(primary: unknown, cleanup: unknown): unknown {
  const body = primary instanceof Error && primary.cause instanceof AggregateError
    ? primary.cause : primary;
  return cleanup === undefined
    ? body
    : new AggregateError(
        [body, cleanup],
        "Document apply and prepublication cleanup both failed.",
        { cause: body }
      );
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
    const handled = await handleApplyFailure(dependencies, request, plan, state, error);
    return {
      primaryFailure: applyFailureEvidence(error, handled.cleanupFailure),
      retainTransactionBarrier: state.retainTransactionBarrier,
      value: handled.receipt
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

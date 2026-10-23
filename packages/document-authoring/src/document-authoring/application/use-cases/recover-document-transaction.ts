import { observe } from "./document-recovery-observation.js";
import type { DocumentReceiptContract as DocumentReceipt } from "../model/document-receipt.js";

import type { DocumentTransactionCoordinator } from "../ports/document-transaction-coordinator.js";
import { hasExactDocumentRecoveryArtifacts } from "../policies/project-document-transaction-inspection.js";
import { classifyDocumentRecovery } from "../policies/classify-document-recovery.js";
import {
  continuePendingPublication,
  errorMessage,
  finalizeDocumentTransaction,
  isCancellation,
  materializeDocumentParentDirectories,
  type ActiveDocumentJournal,
  type DocumentTransactionRequest,
  type DocumentTransactionRuntime,
} from "./document-transaction-continuation.js";
import { directoryReceiptEvidence, recoveryReceipt } from "./document-transaction-receipts.js";
import { DocumentTransactionUseCaseError } from "./document-transaction-error.js";
import { assertNonzeroDocumentPhysicalIdentity } from "../model/document-physical-identity.js";
import {
  executeWithDocumentTransactionLease,
  type DocumentTransactionExecution,
} from "./document-transaction-execution.js";

export interface RecoverDocumentTransactionDependencies extends DocumentTransactionRuntime {
  readonly coordinator: DocumentTransactionCoordinator;
}

export type RecoverDocumentTransactionRequest = DocumentTransactionRequest;

function signalOption(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

function transactionFailure(error: unknown): DocumentTransactionUseCaseError {
  if (error instanceof DocumentTransactionUseCaseError) {
    return error;
  }
  return new DocumentTransactionUseCaseError(
    "DOCUMENT_TRANSACTION_INCONSISTENT",
    `Document recovery could not establish a truthful outcome: ${errorMessage(error)}`,
    { cause: error },
  );
}

async function readActiveJournal(
  dependencies: RecoverDocumentTransactionDependencies,
): Promise<ActiveDocumentJournal> {
  let stored;
  try {
    stored = await dependencies.journal.read();
  } catch (error) {
    throw new DocumentTransactionUseCaseError(
      "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
      "Document recovery evidence cannot be trusted; no Receipt can be bound safely.",
      { cause: error },
    );
  }
  if (stored === undefined) {
    throw new DocumentTransactionUseCaseError(
      "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
      "Coordinator reported recovery but the trusted document journal is absent.",
    );
  }
  // Recheck the journal actually read under the lease, even if the slot changed
  // after the coordinator's inspection. No recovery effect precedes this proof.
  if (
    !hasExactDocumentRecoveryArtifacts(
      stored.envelope,
      dependencies.compiler,
      dependencies.kernelArtifact,
    )
  ) {
    throw new DocumentTransactionUseCaseError(
      "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
      "Document recovery requires the exact recorded Authoring and Mutation artifacts; evidence was preserved.",
    );
  }
  return { authority: stored.authority, envelope: stored.envelope };
}

async function activeRecoveryReceipt(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest,
  active: ActiveDocumentJournal,
  options: Parameters<typeof recoveryReceipt>[2],
): Promise<DocumentReceipt> {
  let evidence = directoryReceiptEvidence(active.envelope);
  if (active.envelope.schemaVersion === 4) {
    try {
      const inspection = await dependencies.parentMaterializer.inspect({
        consumerRoot: request.consumerRoot,
        journal: {
          anchorIdentity: active.envelope.journal.parentMaterialization.anchorIdentity,
          createdDirectories: active.envelope.journal.parentMaterialization.createdDirectories,
          plan: active.envelope.journal.plan.parentMaterialization,
          schemaVersion: 2,
        },
      });
      if (inspection.state !== "current") {
        evidence =
          evidence === undefined
            ? undefined
            : {
                observedCreatedDirectories: evidence.observedCreatedDirectories,
                state: "preserved-unknown",
              };
      }
    } catch {
      evidence =
        evidence === undefined
          ? undefined
          : {
              observedCreatedDirectories: evidence.observedCreatedDirectories,
              state: "preserved-unknown",
            };
    }
  }
  return recoveryReceipt(dependencies.schema, active.envelope.journal.plan, {
    ...options,
    ...(evidence === undefined ? {} : { directoryEvidence: evidence }),
  });
}

async function executeRecoveryDecision(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest,
  active: ActiveDocumentJournal,
  observed: Awaited<ReturnType<typeof observe>>,
  action: Exclude<ReturnType<typeof classifyDocumentRecovery>["action"], "manual">,
): Promise<DocumentReceipt> {
  switch (action) {
    case "resume-prepare":
      return continuePendingPublication(dependencies, request, active);
    case "resume-publish":
      if (observed.temporary === undefined) {
        throw new DocumentTransactionUseCaseError(
          "DOCUMENT_TRANSACTION_INCONSISTENT",
          "Recovery classifier requested publication without a bound temporary.",
        );
      }
      return continuePendingPublication(dependencies, request, active, observed.temporary);
    case "finalize-checks": {
      assertNonzeroDocumentPhysicalIdentity(
        active.envelope.state === "PUBLISHED"
          ? active.envelope.journal.publicationIdentity
          : undefined,
      );
      const finalized = await finalizeDocumentTransaction(
        dependencies,
        { consumerRoot: request.consumerRoot },
        active,
        "applied",
        { authority: "persisted-plan" },
      );
      return (
        finalized ??
        activeRecoveryReceipt(dependencies, request, active, {
          message: "Recovered publication failed stable final verification.",
          publication: "published",
          ruleId: "document.transaction.final-verification",
        })
      );
    }
    case "already-applied": {
      const finalized = await finalizeDocumentTransaction(
        dependencies,
        request,
        active,
        "already-applied",
      );
      return (
        finalized ??
        activeRecoveryReceipt(dependencies, request, active, {
          message: "Preexisting exact output failed stable final verification.",
          publication: "none",
          ruleId: "document.transaction.final-verification",
        })
      );
    }
  }
}

async function resumeV4ParentMaterialization(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest,
  active: ActiveDocumentJournal,
): Promise<DocumentReceipt | undefined> {
  if (
    active.envelope.schemaVersion !== 4 ||
    (active.envelope.state !== "PREPARED" && active.envelope.state !== "MATERIALIZING")
  ) {
    return undefined;
  }
  const plan = active.envelope.journal.plan;
  const authority = await dependencies.authority.assess({
    consumerRoot: request.consumerRoot,
    plan,
    ...signalOption(request.signal),
  });
  request.signal?.throwIfAborted();
  if (authority.state !== "current") {
    return activeRecoveryReceipt(dependencies, request, active, {
      message: authority.reason,
      publication: "none",
      ruleId: "document.transaction.recovery-authority",
    });
  }
  if (
    active.envelope.state === "PREPARED" &&
    active.envelope.journal.destination.state === "preexisting"
  ) {
    const finalized = await finalizeDocumentTransaction(
      dependencies,
      request,
      active,
      "already-applied",
    );
    return (
      finalized ??
      activeRecoveryReceipt(dependencies, request, active, {
        message: "Preexisting exact output failed stable final verification.",
        publication: "none",
        ruleId: "document.transaction.final-verification",
      })
    );
  }
  let current = active;
  try {
    current = await materializeDocumentParentDirectories(
      dependencies,
      request,
      active,
      (durable) => {
        current = durable;
      },
    );
  } catch (error) {
    return activeRecoveryReceipt(dependencies, request, current, {
      manual: true,
      message: `Directory materialization cannot resume safely: ${errorMessage(error)}`,
      publication: "none",
      ruleId: "document.transaction.directory-materialization",
    });
  }
  const [destination, temporary] = await Promise.all([
    dependencies.fileState.classifyDestination({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal),
    }),
    dependencies.fileState.classifyDerivedTemporary({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal),
    }),
  ]);
  request.signal?.throwIfAborted();
  if (destination.state !== "absent" || temporary.state !== "absent") {
    return activeRecoveryReceipt(dependencies, request, current, {
      manual: true,
      message: `Prepublication v4 evidence is not empty: destination=${destination.state}, temporary=${temporary.state}.`,
      publication: destination.state === "exact" ? "unknown" : "none",
      ruleId: "document.transaction.orphan-temporary",
    });
  }
  return continuePendingPublication(dependencies, request, current);
}

async function runRecovery(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest,
): Promise<DocumentReceipt> {
  const active = await readActiveJournal(dependencies);
  const plan = active.envelope.journal.plan;
  const resumedMaterialization = await resumeV4ParentMaterialization(dependencies, request, active);
  if (resumedMaterialization !== undefined) {
    return resumedMaterialization;
  }
  if (active.envelope.schemaVersion === 4) {
    const inspection = await dependencies.parentMaterializer.inspect({
      consumerRoot: request.consumerRoot,
      journal: {
        anchorIdentity: active.envelope.journal.parentMaterialization.anchorIdentity,
        createdDirectories: active.envelope.journal.parentMaterialization.createdDirectories,
        plan: active.envelope.journal.plan.parentMaterialization,
        schemaVersion: 2,
      },
    });
    if (inspection.state !== "current" || inspection.nextDirectory !== undefined) {
      return activeRecoveryReceipt(dependencies, request, active, {
        manual: true,
        message:
          inspection.state === "current"
            ? "Directory materialization evidence is incomplete."
            : `Directory materialization evidence is unsafe: ${inspection.reason}.`,
        publication: active.envelope.state === "PUBLISHED" ? "published" : "unknown",
        ruleId: "document.transaction.directory-evidence",
      });
    }
  }
  const observed = await observe(dependencies, request, active);
  // Read-only adapters may observe cancellation and still return a value.
  // Recheck before interpreting evidence or entering any recovery mutation.
  request.signal?.throwIfAborted();
  const decision = classifyDocumentRecovery(observed.observation);
  if (decision.action === "manual") {
    return activeRecoveryReceipt(dependencies, request, active, {
      manual: true,
      message: `Automatic recovery is unsafe: ${decision.reason}.`,
      publication: active.envelope.state === "PUBLISHED" ? "published" : "unknown",
      ruleId: `document.transaction.${decision.reason}`,
    });
  }
  if (
    decision.action === "resume-prepare" ||
    decision.action === "resume-publish" ||
    decision.action === "already-applied"
  ) {
    const authority = await dependencies.authority.assess({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal),
    });
    // Mutable profile authority is relevant only before publication. Once the
    // identity-bound publication boundary is crossed, the exact-build journal
    // and persisted Plan are the recovery authority.
    request.signal?.throwIfAborted();
    if (authority.state !== "current") {
      return activeRecoveryReceipt(dependencies, request, active, {
        message: authority.reason,
        publication: "none",
        ruleId: "document.transaction.recovery-authority",
      });
    }
  }
  return executeRecoveryDecision(dependencies, request, active, observed, decision.action);
}

async function executeRecovery(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest,
): Promise<DocumentTransactionExecution<DocumentReceipt>> {
  try {
    const value = await runRecovery(dependencies, request);
    return {
      retainTransactionBarrier: value.outcome !== "applied" && value.outcome !== "already-applied",
      value,
    };
  } catch (error) {
    const failure = isCancellation(error, request.signal) ? error : transactionFailure(error);
    throw failure;
  }
}

/** Recovers only a current, strictly validated v3/v2 transaction. */
export async function recoverDocumentTransaction(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest,
): Promise<DocumentReceipt> {
  const lease = await dependencies.coordinator.acquire({ mode: "recover" });
  return executeWithDocumentTransactionLease(
    lease,
    async () => {
      if (lease.status.state !== "recoverable") {
        throw new DocumentTransactionUseCaseError(
          "DOCUMENT_TRANSACTION_COORDINATION_FAILED",
          "Document recovery requires a coordinator-qualified recoverable transaction.",
        );
      }
      return executeRecovery(dependencies, request);
    },
    "Document recovery and transaction lease release both failed.",
  );
}

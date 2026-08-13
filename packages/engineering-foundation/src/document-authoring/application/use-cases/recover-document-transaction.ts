import type { DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentOwnedTemporary } from "../model/document-transaction.js";
import type { DocumentTransactionCoordinator } from "../ports/document-transaction-coordinator.js";
import {
  classifyDocumentRecovery,
  type DocumentRecoveryDestinationObservation,
  type DocumentRecoveryObservation,
  type DocumentRecoveryTemporaryObservation
} from "../policies/classify-document-recovery.js";
import {
  completePublishedTransaction,
  continuePendingPublication,
  errorMessage,
  finalizeDocumentTransaction,
  recoveryReceipt,
  type ActiveDocumentJournal,
  type DocumentTransactionRequest,
  type DocumentTransactionRuntime
} from "./document-transaction-continuation.js";
import { DocumentTransactionUseCaseError } from "./document-transaction-error.js";
import { assertNonzeroDocumentPhysicalIdentity } from "../model/document-physical-identity.js";

export interface RecoverDocumentTransactionDependencies
extends DocumentTransactionRuntime {
  readonly coordinator: DocumentTransactionCoordinator;
}

export type RecoverDocumentTransactionRequest = DocumentTransactionRequest;

function signalOption(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

function nonzero(identity: {
  readonly birthtimeNs: string;
  readonly dev: string;
  readonly ino: string;
}): boolean {
  return identity.birthtimeNs !== "0" && identity.dev !== "0" && identity.ino !== "0";
}

function sameIdentity(
  left: { readonly birthtimeNs: string; readonly dev: string; readonly ino: string },
  right: { readonly birthtimeNs: string; readonly dev: string; readonly ino: string }
): boolean {
  return left.birthtimeNs === right.birthtimeNs &&
    left.dev === right.dev && left.ino === right.ino;
}

function destinationObservation(
  active: ActiveDocumentJournal,
  state: Awaited<ReturnType<RecoverDocumentTransactionDependencies["fileState"]["classifyDestination"]>>
): DocumentRecoveryDestinationObservation {
  if (state.state !== "exact") {
    return state;
  }
  if (!nonzero(state.identity)) {
    return { identity: "zero-identity", state: "exact" };
  }
  if (active.envelope.state === "PUBLISHING") {
    return {
      identity: sameIdentity(state.identity, active.envelope.journal.ownedTemporary.identity)
        ? "bound-temporary"
        : "different",
      state: "exact"
    };
  }
  if (active.envelope.state === "PUBLISHED") {
    return {
      identity: sameIdentity(state.identity, active.envelope.journal.publicationIdentity)
        ? "bound-publication"
        : "different",
      state: "exact"
    };
  }
  return { identity: "unbound", state: "exact" };
}

function temporaryObservation(
  active: ActiveDocumentJournal,
  state: Awaited<ReturnType<RecoverDocumentTransactionDependencies["fileState"]["classifyDerivedTemporary"]>>,
  exactState?: Awaited<ReturnType<RecoverDocumentTransactionDependencies["fileState"]["classifyTemporary"]>>
): DocumentRecoveryTemporaryObservation {
  if (active.envelope.state !== "PUBLISHING") {
    return state.state === "absent"
      ? { state: "absent" }
      : state.state === "unverifiable"
        ? { state: "unverifiable" }
        : nonzero(state.identity)
          ? { identity: "nonzero", state: "replaced" }
          : { state: "zero-identity" };
  }
  if (!nonzero(active.envelope.journal.ownedTemporary.identity)) {
    return { state: "zero-identity" };
  }
  if (exactState?.state === "absent") {
    return { state: "absent" };
  }
  if (exactState?.state === "owned-exact") {
    return { identity: "nonzero", state: "exact" };
  }
  if (exactState?.state === "unverifiable") {
    return { state: "unverifiable" };
  }
  return { identity: "nonzero", state: "replaced" };
}

async function observe(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest,
  active: ActiveDocumentJournal
): Promise<{
  readonly observation: DocumentRecoveryObservation;
  readonly temporary?: DocumentOwnedTemporary;
}> {
  const plan = active.envelope.journal.plan;
  const [destination, derived] = await Promise.all([
    dependencies.fileState.classifyDestination({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    }),
    dependencies.fileState.classifyDerivedTemporary({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    })
  ]);
  const temporary = active.envelope.state === "PUBLISHING"
    ? active.envelope.journal.ownedTemporary
    : undefined;
  const exactTemporary = temporary === undefined
    ? undefined
    : await dependencies.fileState.classifyTemporary({
        consumerRoot: request.consumerRoot,
        temporary,
        ...signalOption(request.signal)
      });
  const journal = active.envelope.state === "PREPARED"
    ? {
        boundIdentity: "none" as const,
        fileIdentity: nonzero(active.identity) ? "nonzero" as const : "zero-identity" as const,
        lifecycle: "PREPARED" as const,
        preparedState: active.envelope.journal.destination.state,
        version: "v2" as const
      }
    : active.envelope.state === "PUBLISHING"
      ? {
          boundIdentity: nonzero(active.envelope.journal.ownedTemporary.identity)
            ? "temporary" as const : "zero-identity" as const,
          fileIdentity: nonzero(active.identity) ? "nonzero" as const : "zero-identity" as const,
          lifecycle: "PUBLISHING" as const,
          version: "v2" as const
        }
      : {
          boundIdentity: nonzero(active.envelope.journal.publicationIdentity)
            ? "publication" as const : "zero-identity" as const,
          fileIdentity: nonzero(active.identity) ? "nonzero" as const : "zero-identity" as const,
          lifecycle: "PUBLISHED" as const,
          version: "v2" as const
        };
  return {
    observation: {
      destination: destinationObservation(active, destination),
      journal,
      temporary: temporaryObservation(active, derived, exactTemporary)
    },
    ...(temporary === undefined ? {} : { temporary })
  };
}

/** Recovers only a current, strictly validated v3/v2 transaction. */
export async function recoverDocumentTransaction(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest
): Promise<DocumentReceipt> {
  const lease = await dependencies.coordinator.acquire({ mode: "recover" });
  let retainBarrier = true;
  try {
    if (lease.status.state !== "recoverable") {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_COORDINATION_FAILED",
        "Document recovery requires a coordinator-qualified recoverable transaction."
      );
    }
    let stored;
    try {
      stored = await dependencies.journal.read();
    } catch (error) {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
        "Document recovery evidence cannot be trusted; no Receipt can be bound safely.",
        { cause: error }
      );
    }
    if (stored === undefined) {
      throw new DocumentTransactionUseCaseError(
        "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE",
        "Coordinator reported recovery but the trusted document journal is absent."
      );
    }
    const active = { envelope: stored.envelope, identity: stored.identity };
    const plan = active.envelope.journal.plan;
    const authority = await dependencies.authority.assess({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    });
    if (authority.state !== "current") {
      return recoveryReceipt(plan, {
        message: authority.reason,
        publication: active.envelope.state === "PUBLISHED" ? "published" : "unknown",
        ruleId: "document.transaction.recovery-authority"
      });
    }
    const observed = await observe(dependencies, request, active);
    const decision = classifyDocumentRecovery(observed.observation);
    let receipt: DocumentReceipt;
    // A closed recovery matrix is intentionally explicit; each branch maps to
    // one mutation continuation and never falls through optimistically.
    switch (decision.action) {
      case "resume-prepare":
        receipt = await continuePendingPublication(dependencies, request, active);
        break;
      case "resume-publish":
        if (observed.temporary === undefined) {
          throw new DocumentTransactionUseCaseError(
            "DOCUMENT_TRANSACTION_INCONSISTENT",
            "Recovery classifier requested publication without a bound temporary."
          );
        }
        receipt = await continuePendingPublication(
          dependencies,
          request,
          active,
          observed.temporary
        );
        break;
      case "complete-publication":
        if (observed.temporary === undefined) {
          throw new DocumentTransactionUseCaseError(
            "DOCUMENT_TRANSACTION_INCONSISTENT",
            "Recovery classifier requested completion without temporary evidence."
          );
        }
        receipt = await completePublishedTransaction(
          dependencies,
          request,
          active,
          observed.temporary
        );
        break;
      case "finalize-checks": {
        assertNonzeroDocumentPhysicalIdentity(active.envelope.state === "PUBLISHED"
          ? active.envelope.journal.publicationIdentity : undefined);
        const finalized = await finalizeDocumentTransaction(
          dependencies,
          { consumerRoot: request.consumerRoot },
          active,
          "applied"
        );
        receipt = finalized ?? await recoveryReceipt(plan, {
          message: "Recovered publication failed stable final verification.",
          publication: "published",
          ruleId: "document.transaction.final-verification"
        });
        break;
      }
      case "already-applied": {
        const finalized = await finalizeDocumentTransaction(
          dependencies,
          request,
          active,
          "already-applied"
        );
        receipt = finalized ?? await recoveryReceipt(plan, {
          message: "Preexisting exact output failed stable final verification.",
          publication: "none",
          ruleId: "document.transaction.final-verification"
        });
        break;
      }
      case "manual":
        receipt = await recoveryReceipt(plan, {
          manual: true,
          message: `Automatic recovery is unsafe: ${decision.reason}.`,
          publication: active.envelope.state === "PUBLISHED" ? "published" : "unknown",
          ruleId: `document.transaction.${decision.reason}`
        });
        break;
    }
    retainBarrier = receipt.outcome !== "applied" && receipt.outcome !== "already-applied";
    return receipt;
  } catch (error) {
    if (error instanceof DocumentTransactionUseCaseError) {
      throw error;
    }
    throw new DocumentTransactionUseCaseError(
      "DOCUMENT_TRANSACTION_INCONSISTENT",
      `Document recovery could not establish a truthful outcome: ${errorMessage(error)}`,
      { cause: error }
    );
  } finally {
    await lease.release({ retainTransactionBarrier: retainBarrier });
  }
}

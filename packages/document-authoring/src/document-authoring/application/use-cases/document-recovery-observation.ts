import type { DocumentOwnedTemporary } from "../model/document-transaction.js";

import {
  type DocumentRecoveryDestinationObservation,
  type DocumentRecoveryObservation,
  type DocumentRecoveryTemporaryObservation,
} from "../policies/classify-document-recovery.js";
import { type ActiveDocumentJournal } from "./document-transaction-continuation.js";

import { DocumentTransactionUseCaseError } from "./document-transaction-error.js";

import type {
  RecoverDocumentTransactionDependencies,
  RecoverDocumentTransactionRequest,
} from "./recover-document-transaction.js";
function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
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
  right: { readonly birthtimeNs: string; readonly dev: string; readonly ino: string },
): boolean {
  return left.birthtimeNs === right.birthtimeNs && left.dev === right.dev && left.ino === right.ino;
}

function destinationObservation(
  active: ActiveDocumentJournal,
  state: Awaited<
    ReturnType<RecoverDocumentTransactionDependencies["fileState"]["classifyDestination"]>
  >,
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
      state: "exact",
    };
  }
  if (active.envelope.state === "PUBLISHED") {
    return {
      identity: sameIdentity(state.identity, active.envelope.journal.publicationIdentity)
        ? "bound-publication"
        : "different",
      state: "exact",
    };
  }
  return { identity: "unbound", state: "exact" };
}

function temporaryObservation(
  active: ActiveDocumentJournal,
  state: Awaited<
    ReturnType<RecoverDocumentTransactionDependencies["fileState"]["classifyDerivedTemporary"]>
  >,
  exactState?: Awaited<
    ReturnType<RecoverDocumentTransactionDependencies["fileState"]["classifyTemporary"]>
  >,
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

export async function observe(
  dependencies: RecoverDocumentTransactionDependencies,
  request: RecoverDocumentTransactionRequest,
  active: ActiveDocumentJournal,
): Promise<{
  readonly observation: DocumentRecoveryObservation;
  readonly temporary?: DocumentOwnedTemporary;
}> {
  const plan = active.envelope.journal.plan;
  if (active.envelope.state === "MATERIALIZING") {
    throw new DocumentTransactionUseCaseError(
      "DOCUMENT_TRANSACTION_INCONSISTENT",
      "Materializing recovery must be resumed before file publication observation.",
    );
  }
  const [destination, derived] = await Promise.all([
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
  const temporary =
    active.envelope.state === "PUBLISHING" ? active.envelope.journal.ownedTemporary : undefined;
  const exactTemporary =
    temporary === undefined
      ? undefined
      : await dependencies.fileState.classifyTemporary({
          consumerRoot: request.consumerRoot,
          temporary,
          ...signalOption(request.signal),
        });
  const journal =
    active.envelope.state === "PREPARED"
      ? {
          boundIdentity: "none" as const,
          fileIdentity: nonzero(active.authority.identity)
            ? ("nonzero" as const)
            : ("zero-identity" as const),
          lifecycle: "PREPARED" as const,
          preparedState: active.envelope.journal.destination.state,
          version: "v2" as const,
        }
      : active.envelope.state === "PUBLISHING"
        ? {
            boundIdentity: nonzero(active.envelope.journal.ownedTemporary.identity)
              ? ("temporary" as const)
              : ("zero-identity" as const),
            fileIdentity: nonzero(active.authority.identity)
              ? ("nonzero" as const)
              : ("zero-identity" as const),
            lifecycle: "PUBLISHING" as const,
            version: "v2" as const,
          }
        : {
            boundIdentity: nonzero(active.envelope.journal.publicationIdentity)
              ? ("publication" as const)
              : ("zero-identity" as const),
            fileIdentity: nonzero(active.authority.identity)
              ? ("nonzero" as const)
              : ("zero-identity" as const),
            lifecycle: "PUBLISHED" as const,
            version: "v2" as const,
          };
  return {
    observation: {
      destination: destinationObservation(active, destination),
      journal,
      temporary: temporaryObservation(active, derived, exactTemporary),
    },
    ...(temporary === undefined ? {} : { temporary }),
  };
}

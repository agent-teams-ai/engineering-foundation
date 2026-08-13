import { assertNonzeroDocumentPhysicalIdentity } from "../model/document-physical-identity.js";
import type { DocumentTransactionEnvelope } from "../model/document-transaction.js";
import type { DocumentJournalStore, JournalAuthority } from "../ports/document-journal-store.js";
import type { DocumentTransactionCoordinator } from "../ports/document-transaction-coordinator.js";

export interface ReconciliationRuntime {
  readonly coordinator: DocumentTransactionCoordinator;
  readonly journal: DocumentJournalStore;
}

export interface ActiveJournalEvidence {
  readonly envelope: DocumentTransactionEnvelope;
  readonly authority: JournalAuthority;
}

export class DocumentJournalReconciliationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentJournalReconciliationError";
  }
}

function sameEnvelope(left: DocumentTransactionEnvelope, right: DocumentTransactionEnvelope) {
  return left.envelopeDigest === right.envelopeDigest &&
    left.payloadDigest === right.payloadDigest && left.state === right.state;
}

async function evidence(runtime: ReconciliationRuntime) {
  const stored = await runtime.journal.stabilizeForReconciliation();
  return { status: await runtime.coordinator.inspect(), stored };
}

function failure(operation: string, primary: unknown, inspection?: unknown) {
  return new DocumentJournalReconciliationError(
    `${operation} reported failure and durable state is ${inspection === undefined ? "different" : "unverifiable"}.`,
    { cause: inspection === undefined
      ? primary
      : new AggregateError([primary, inspection], `${operation} and reconciliation failed.`) }
  );
}

export async function createJournalReconciled(
  runtime: ReconciliationRuntime,
  envelope: DocumentTransactionEnvelope
): Promise<JournalAuthority> {
  try {
    return await runtime.journal.create(envelope);
  } catch (primary) {
    let observed;
    try { observed = await evidence(runtime); } catch (inspection) {
      throw failure("Journal creation", primary, inspection);
    }
    if (observed.status.state === "recoverable" && observed.stored !== undefined &&
      sameEnvelope(observed.stored.envelope, envelope)) {
      assertNonzeroDocumentPhysicalIdentity(observed.stored.authority.identity);
      return observed.stored.authority;
    }
    if (observed.status.state === "idle" && observed.stored === undefined) {
      throw primary;
    }
    throw failure("Journal creation", primary);
  }
}

export async function replaceJournalReconciled(
  runtime: ReconciliationRuntime,
  active: ActiveJournalEvidence,
  envelope: DocumentTransactionEnvelope
): Promise<JournalAuthority> {
  try {
    return await runtime.journal.replace({ envelope, expectedAuthority: active.authority });
  } catch (primary) {
    let observed;
    try { observed = await evidence(runtime); } catch (inspection) {
      throw failure("Journal replacement", primary, inspection);
    }
    if (observed.status.state !== "manual-recovery-required" && observed.stored !== undefined) {
      if (sameEnvelope(observed.stored.envelope, envelope)) {
        assertNonzeroDocumentPhysicalIdentity(observed.stored.authority.identity);
        return observed.stored.authority;
      }
      if (sameEnvelope(observed.stored.envelope, active.envelope) &&
        observed.stored.authority.authorityDigest === active.authority.authorityDigest &&
        observed.stored.authority.identity.dev === active.authority.identity.dev &&
        observed.stored.authority.identity.ino === active.authority.identity.ino &&
        observed.stored.authority.identity.birthtimeNs === active.authority.identity.birthtimeNs) {
        throw primary;
      }
    }
    throw failure("Journal replacement", primary);
  }
}

export async function removeJournalReconciled(
  runtime: ReconciliationRuntime,
  active: ActiveJournalEvidence
): Promise<void> {
  try { await runtime.journal.remove(active.authority); } catch (primary) {
    let observed;
    try { observed = await evidence(runtime); } catch (inspection) {
      throw failure("Journal removal", primary, inspection);
    }
    if (observed.status.state === "idle" && observed.stored === undefined) {
      return;
    }
    throw failure("Journal removal", primary);
  }
}

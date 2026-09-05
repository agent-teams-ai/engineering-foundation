import type {
  AuthorityScaffoldJournal
} from "../../contract/types.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { sameJournalSlotAuthority as sameScaffoldJournalAuthority } from "@agent-teams/repository-mutation/node";
import {
  NodeScaffoldJournalStore,
  type ScaffoldJournalAuthority,
  type ScaffoldJournalSlotObservation,
  type StoredScaffoldJournal
} from "./node-scaffold-journal-store.js";

export interface ActiveScaffoldJournal {
  readonly journal: AuthorityScaffoldJournal;
  readonly journalAuthority: ScaffoldJournalAuthority;
}

function reconciliationFailure(
  operation: string,
  primary: unknown,
  inspection?: unknown
): ScaffoldError {
  const rawPrimaryMessage = primary instanceof Error
    ? primary.message
    : `${operation} failed`;
  const primaryMessage = operation === "Journal removal" &&
    rawPrimaryMessage.includes("invalid strict JSON")
    ? "Scaffolding journal changed before it could be removed."
    : rawPrimaryMessage.includes("journal temporary identity or bytes changed")
    ? "Scaffolding journal temporary path was replaced concurrently."
    : rawPrimaryMessage.includes("Canonical scaffolding journal identity or bytes changed")
      ? "Scaffolding journal changed before it could be removed."
      : rawPrimaryMessage.includes("journal evidence identity or bytes changed")
        ? "Quarantined scaffolding journal changed concurrently."
        : rawPrimaryMessage;
  return new ScaffoldError(
    "SCAFFOLD_RECOVERY_REQUIRED",
    `${primaryMessage} Durable journal state cannot be classified safely; all evidence was preserved.`,
    [],
    {
      cause: inspection === undefined
        ? primary
        : new AggregateError(
            [primary, inspection],
            `${operation} and journal reconciliation both failed.`,
            { cause: primary }
          )
    }
  );
}

async function observeAfterFailure(
  store: NodeScaffoldJournalStore,
  operation: string,
  primary: unknown
): Promise<ScaffoldJournalSlotObservation> {
  try {
    return await store.stabilizeForReconciliation();
  } catch (inspection) {
    throw reconciliationFailure(operation, primary, inspection);
  }
}

function stableStored(
  observation: ScaffoldJournalSlotObservation
): StoredScaffoldJournal | undefined {
  return observation.outcome === "recovery-required"
    ? observation.canonical
    : observation.stored;
}

export async function readScaffoldJournal(
  store: NodeScaffoldJournalStore
): Promise<ActiveScaffoldJournal | undefined> {
  const stored = await store.read();
  return stored === undefined
    ? undefined
    : { journal: stored.journal, journalAuthority: stored.authority };
}

export async function createScaffoldJournalReconciled(
  store: NodeScaffoldJournalStore,
  journal: AuthorityScaffoldJournal
): Promise<ScaffoldJournalAuthority> {
  try {
    return await store.create(journal);
  } catch (primary) {
    const observed = await observeAfterFailure(store, "Journal creation", primary);
    if (observed.outcome === "committed" && observed.stored !== undefined) {
      return observed.stored.authority;
    }
    if (
      observed.outcome === "not-applied" ||
      (observed.outcome === "stable" && observed.stored === undefined)
    ) {
      throw primary;
    }
    throw reconciliationFailure("Journal creation", primary);
  }
}

export async function replaceScaffoldJournalReconciled(
  store: NodeScaffoldJournalStore,
  active: ActiveScaffoldJournal,
  journal: AuthorityScaffoldJournal
): Promise<ScaffoldJournalAuthority> {
  try {
    return await store.replace(active.journalAuthority, journal);
  } catch (primary) {
    const observed = await observeAfterFailure(store, "Journal replacement", primary);
    if (observed.outcome === "committed" && observed.stored !== undefined) {
      return observed.stored.authority;
    }
    const stored = stableStored(observed);
    if (
      observed.outcome === "not-applied" ||
      (observed.outcome === "stable" && stored !== undefined &&
        sameScaffoldJournalAuthority(stored.authority, active.journalAuthority))
    ) {
      throw primary;
    }
    throw reconciliationFailure("Journal replacement", primary);
  }
}

export async function removeScaffoldJournalReconciled(
  store: NodeScaffoldJournalStore,
  active: ActiveScaffoldJournal
): Promise<void> {
  try {
    await store.remove(active.journalAuthority);
  } catch (primary) {
    const observed = await observeAfterFailure(store, "Journal removal", primary);
    if (observed.outcome === "committed") {
      return;
    }
    const stored = stableStored(observed);
    if (
      observed.outcome === "not-applied" ||
      (observed.outcome === "stable" && stored !== undefined &&
        sameScaffoldJournalAuthority(stored.authority, active.journalAuthority))
    ) {
      throw primary;
    }
    throw reconciliationFailure("Journal removal", primary);
  }
}

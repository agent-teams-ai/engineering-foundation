import type { AuthorityScaffoldJournal } from "../../contract/types.js";
import type {
  ScaffoldJournalAuthority,
  ScaffoldJournalSlotObservation,
  StoredScaffoldJournal
} from "./node-scaffold-journal-evidence.js";

/** Persistence operations required by scaffolding publication and reconciliation. */
export interface ScaffoldJournalStore {
  read(): Promise<StoredScaffoldJournal | undefined>;
  stabilizeForReconciliation(): Promise<ScaffoldJournalSlotObservation>;
  create(journal: AuthorityScaffoldJournal): Promise<ScaffoldJournalAuthority>;
  replace(expected: ScaffoldJournalAuthority, journal: AuthorityScaffoldJournal): Promise<ScaffoldJournalAuthority>;
  remove(expected: ScaffoldJournalAuthority): Promise<void>;
}

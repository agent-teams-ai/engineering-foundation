import type { ScaffoldJournalStore } from "./scaffold-journal-store.js";
import type { AuthorityScaffoldPlan, ScaffoldAuthorityAssessment } from "../../application/model/scaffold-compilation.js";
import type { ScaffoldTransactionProvider } from "../../application/ports/scaffold-transactions.js";
import type { NodeScaffoldJournalStoreOperations } from "./node-scaffold-journal-store.js";

export type AssessScaffoldPlanAuthority = (
  consumerRoot: string,
  plan: AuthorityScaffoldPlan
) => Promise<ScaffoldAuthorityAssessment>;

export interface ScaffoldFilesystemDependencies {
  readonly assertPlanSchema: (plan: AuthorityScaffoldPlan) => Promise<void>;
  readonly assessPlanAuthority: AssessScaffoldPlanAuthority;
  readonly createTransactions: ScaffoldTransactionProvider;
  readonly createJournalStore: (
    consumerRoot: string,
    operations?: NodeScaffoldJournalStoreOperations
  ) => ScaffoldJournalStore;
}

import type {
  AuthorityScaffoldJournal
} from "../../contract/types.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertAuthorityScaffoldPlanDigest } from "../../kernel/plan-validation.js";

function assertAuthorityJournalOperationBindings(
  journal: AuthorityScaffoldJournal
): void {
  if (journal.operations.length !== journal.plan.operations.length) {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      "Scaffolding recovery journal operation evidence does not match its Plan."
    );
  }
  const planOperations = new Map(
    journal.plan.operations.map((operation) => [operation.id, operation])
  );
  const seen = new Set<string>();
  for (const operation of journal.operations) {
    const planned = planOperations.get(operation.operationId);
    if (
      planned === undefined ||
      planned.path !== operation.path ||
      seen.has(operation.operationId)
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding recovery journal operation evidence is invalid."
      );
    }
    seen.add(operation.operationId);
  }
}

/** Validates all semantic bindings of a schema-valid v1 recovery journal. */
export function assertAuthorityScaffoldJournal(
  journal: AuthorityScaffoldJournal
): void {
  assertAuthorityScaffoldPlanDigest(journal.plan);
  assertAuthorityJournalOperationBindings(journal);
}

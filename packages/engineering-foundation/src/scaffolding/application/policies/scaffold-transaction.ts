import { FoundationTransactionError } from "../../../transaction-coordination/application/foundation-transaction-error.js";
import { releaseFoundationTransactionLeaseSafely } from "../../../transaction-coordination/application/release-foundation-transaction-lease.js";
import { ScaffoldError } from "../../scaffold-error.js";
import type {
  ScaffoldTransactionDependencies,
  ScaffoldTransactionLease,
  ScaffoldTransactionProvider,
  ScaffoldTransactions
} from "../ports/scaffold-transactions.js";

/** Each operation gets one coordinator and cleanup authority bound to its root. */
export function createScaffoldTransactionProvider(
  dependencies: ScaffoldTransactionDependencies
): ScaffoldTransactionProvider {
  return async (root) => ({
    coordinator: await dependencies.createCoordinator(root),
    createCleanupTransition: (transactionId) =>
      dependencies.createCleanupTransition(root, transactionId)
  });
}

/** Scaffolding owns admission diagnostics and the evidence-fenced lease lifetime. */
export async function acquireScaffoldingTransaction(
  coordinator: ScaffoldTransactions["coordinator"]
): Promise<ScaffoldTransactionLease> {
  try {
    const lease = await coordinator.acquire({
      requestedMutation: "scaffolding",
      allowRecoveryOf: "scaffolding"
    });
    return {
      releaseAfterInspection: (inspectRetainTransactionBarrier) =>
        releaseFoundationTransactionLeaseSafely({ lease, inspectRetainTransactionBarrier })
    };
  } catch (error) {
    if (!(error instanceof FoundationTransactionError)) {
      throw error;
    }
    const message =
      error.status.state === "manual-recovery-required" &&
      error.status.reason === "orphan-temporary"
      ? "Scaffolding journal temporary cannot be proven transaction-owned; it was preserved and requires manual recovery."
      : error.message;
    throw new ScaffoldError("SCAFFOLD_RECOVERY_REQUIRED", message, [], {
      cause: error
    });
  }
}

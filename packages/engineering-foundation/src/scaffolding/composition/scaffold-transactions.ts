import { createScaffoldTransactionProvider } from "../application/policies/scaffold-transaction.js";
import type {
  ScaffoldTransactionDependencies,
  ScaffoldTransactionProvider,
  ScaffoldTransactions
} from "../application/ports/scaffold-transactions.js";

type SyncStateDirectory = (stateDirectory: string) => Promise<void>;
type CreateCleanupTransition = (
  root: string,
  transactionId: string,
  operations: { readonly syncStateDirectory: SyncStateDirectory }
) => ReturnType<ScaffoldTransactions["createCleanupTransition"]>;

/** Select Node cleanup durability at composition; application owns root binding. */
export function createNodeScaffoldTransactionProvider(
  createCoordinator: ScaffoldTransactionDependencies["createCoordinator"],
  createCleanupTransition: CreateCleanupTransition,
  syncStateDirectory: SyncStateDirectory
): ScaffoldTransactionProvider {
  return createScaffoldTransactionProvider({
    createCoordinator,
    createCleanupTransition: (root, transactionId) =>
      createCleanupTransition(root, transactionId, { syncStateDirectory })
  });
}

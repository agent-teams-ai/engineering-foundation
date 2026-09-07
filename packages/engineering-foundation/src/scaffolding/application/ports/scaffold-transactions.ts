import type { OwnedTemporaryCleanupTransitionPort } from "@agent-teams/repository-mutation/node";
import type { FoundationTransactionCoordinator } from "../../../transaction-coordination/application/foundation-transaction-coordinator.js";

/** Authority supplied by module composition; no filesystem or adapter lifecycle. */
export interface ScaffoldTransactions {
  readonly coordinator: Pick<FoundationTransactionCoordinator, "acquire">;
  createCleanupTransition(transactionId: string): OwnedTemporaryCleanupTransitionPort;
}

export type ScaffoldTransactionProvider = (
  canonicalRoot: string
) => Promise<ScaffoldTransactions>;

export interface ScaffoldTransactionDependencies {
  readonly createCoordinator: (
    canonicalRoot: string
  ) => Promise<ScaffoldTransactions["coordinator"]>;
  readonly createCleanupTransition: (
    canonicalRoot: string,
    transactionId: string
  ) => OwnedTemporaryCleanupTransitionPort;
}

export interface ScaffoldTransactionLease {
  releaseAfterInspection(inspectEvidence: () => Promise<boolean>): Promise<void>;
}

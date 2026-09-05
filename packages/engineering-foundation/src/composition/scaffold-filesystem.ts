import type { ScaffoldTransactions } from "../scaffolding/application/ports/scaffold-transactions.js";
import type {
  AuthorityScaffoldPlan
} from "../scaffolding/application/model/scaffold-compilation.js";
import type {
  AuthorityScaffoldReceipt
} from "../scaffolding/contract/receipt-authority-types.js";
import type {
  AuthorityScaffoldRecoveryScope
} from "../scaffolding/application/model/recovery-scope.js";
import {
  applyAuthorityFilesystemScaffoldWithFaultInjection as apply,
  type ScaffoldAuthorityFaultInjector
} from "../scaffolding/adapters/node/filesystem-authority-workspace.js";
import { recoverAuthorityFilesystemScaffoldWithFaultInjection as recover } from "../scaffolding/adapters/node/filesystem-authority-recovery.js";
import { createNodeFoundationCleanupTransition } from "../transaction-coordination/adapters/node/node-foundation-cleanup-transition.js";
import { syncFoundationStateDirectory } from "../transaction-coordination/adapters/node/node-foundation-state-directory.js";
import { createNodeFoundationTransactionCoordinator } from "./node-foundation-transaction-coordinator.js";

async function transactions(root: string): Promise<ScaffoldTransactions> {
  return {
    coordinator: await createNodeFoundationTransactionCoordinator(root),
    createCleanupTransition: (transactionId) => createNodeFoundationCleanupTransition(
      root, transactionId, { syncStateDirectory: syncFoundationStateDirectory }
    )
  };
}

/** Private composition for production and fault-injection conformance. */
export async function applyAuthorityFilesystemScaffoldWithFaultInjection(
  consumerRoot: string,
  plan: AuthorityScaffoldPlan,
  faultInjector?: ScaffoldAuthorityFaultInjector
): Promise<AuthorityScaffoldReceipt> {
  return apply(consumerRoot, plan, faultInjector, transactions);
}

export async function recoverAuthorityFilesystemScaffoldWithFaultInjection(
  consumerRoot: string,
  scope?: AuthorityScaffoldRecoveryScope,
  faultInjector?: ScaffoldAuthorityFaultInjector
): Promise<AuthorityScaffoldReceipt | undefined> {
  return recover(consumerRoot, scope, faultInjector, transactions);
}

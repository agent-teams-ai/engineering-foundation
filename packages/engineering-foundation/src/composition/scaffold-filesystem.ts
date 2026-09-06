import { assertSchema } from "../schema-catalog.js";
import { createNodeScaffoldFilesystem } from "../scaffolding/composition/node-scaffolding.js";
import { createNodeScaffoldTransactionProvider } from "../scaffolding/composition/scaffold-transactions.js";
import type {
  AuthorityScaffoldPlan
} from "../scaffolding/application/model/scaffold-compilation.js";
import type {
  AuthorityScaffoldReceipt
} from "../scaffolding/contract/receipt-authority-types.js";
import type {
  AuthorityScaffoldRecoveryScope
} from "../scaffolding/application/model/recovery-scope.js";
import type {
  ScaffoldAuthorityFaultInjector
} from "../scaffolding/adapters/node/filesystem-authority-workspace.js";
import { createNodeFoundationCleanupTransition } from "../transaction-coordination/adapters/node/node-foundation-cleanup-transition.js";
import { syncFoundationStateDirectory } from "../transaction-coordination/adapters/node/node-foundation-state-directory.js";
import { createNodeFoundationTransactionCoordinator } from "./node-foundation-transaction-coordinator.js";

export const createScaffoldTransactions = createNodeScaffoldTransactionProvider(
  createNodeFoundationTransactionCoordinator,
  createNodeFoundationCleanupTransition,
  syncFoundationStateDirectory
);
const filesystem = createNodeScaffoldFilesystem(assertSchema, createScaffoldTransactions);

/** Private composition for production and fault-injection conformance. */
export async function applyAuthorityFilesystemScaffoldWithFaultInjection(
  consumerRoot: string,
  plan: AuthorityScaffoldPlan,
  faultInjector?: ScaffoldAuthorityFaultInjector
): Promise<AuthorityScaffoldReceipt> {
  return filesystem.applyAuthorityFilesystemScaffoldWithFaultInjection(consumerRoot, plan, faultInjector);
}

export async function recoverAuthorityFilesystemScaffoldWithFaultInjection(
  consumerRoot: string,
  scope?: AuthorityScaffoldRecoveryScope,
  faultInjector?: ScaffoldAuthorityFaultInjector
): Promise<AuthorityScaffoldReceipt | undefined> {
  return filesystem.recoverAuthorityFilesystemScaffoldWithFaultInjection(consumerRoot, scope, faultInjector);
}

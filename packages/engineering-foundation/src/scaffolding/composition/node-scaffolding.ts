import { createAuthorityScaffoldRegistry } from "./scaffold-registry.js";
import type { AuthorityScaffoldPlan } from "../application/model/scaffold-compilation.js";
import type { AuthorityScaffoldRecoveryScope } from "../application/model/recovery-scope.js";
import type { ScaffoldAuthorityFaultInjector } from "../adapters/node/filesystem-authority-workspace.js";
import type { ScaffoldTransactionProvider } from "../application/ports/scaffold-transactions.js";
import type { ScaffoldSchemaValidator } from "../adapters/schema-validation.js";
import type { ScaffoldFilesystemDependencies } from "../adapters/node/scaffold-filesystem-dependencies.js";
import { createScaffoldingApi, type ScaffoldingApi } from "../adapters/inbound/create-scaffolding-api.js";
import { planAuthorityScaffoldFromFile } from "../adapters/inbound/plan-authority-scaffold-from-file.js";
import { readAuthorityScaffoldPlanFile } from "../adapters/node/node-authority-input-loader.js";
import { validateAuthorityScaffoldReceipt } from "../adapters/node/node-authority-receipt-validator.js";
import { assessScaffoldPlanAuthority } from "../adapters/node/node-plan-authority.js";
import { NodeScaffoldJournalStore } from "../adapters/node/node-scaffold-journal-store.js";
import { applyAuthorityFilesystemScaffoldWithFaultInjection as apply } from "../adapters/node/filesystem-authority-workspace.js";
import { recoverAuthorityFilesystemScaffoldWithFaultInjection as recover } from "../adapters/node/filesystem-authority-recovery.js";

export function createScaffoldFilesystemDependencies(
  assertSchema: ScaffoldSchemaValidator,
  createTransactions: ScaffoldTransactionProvider
): ScaffoldFilesystemDependencies {
  return {
    assertPlanSchema: (plan) => assertSchema("scaffold-plan/v1", plan, "scaffold-apply-plan"),
    assessPlanAuthority: (root, plan) => assessScaffoldPlanAuthority(root, plan, assertSchema, createAuthorityScaffoldRegistry),
    createJournalStore: (root, operations) => new NodeScaffoldJournalStore(root, assertSchema, operations),
    createTransactions
  };
}

export function createNodeScaffoldingApi(
  assertSchema: ScaffoldSchemaValidator,
  createTransactions: ScaffoldTransactionProvider
): ScaffoldingApi {
  const filesystem = createScaffoldFilesystemDependencies(assertSchema, createTransactions);
  return createScaffoldingApi({
    planScaffoldFromFile: (options) => planAuthorityScaffoldFromFile(options, assertSchema, createAuthorityScaffoldRegistry),
    applyFilesystemScaffold: (root, plan) => apply(root, plan, undefined, filesystem),
    recoverFilesystemScaffold: (root, scope) => recover(root, scope, undefined, filesystem),
    readScaffoldPlanFile: (root, path) => readAuthorityScaffoldPlanFile(root, path, assertSchema),
    validateScaffoldReceipt: (receipt, plan) => validateAuthorityScaffoldReceipt(receipt, assertSchema, plan)
  });
}

/** Feature-owned binding for the existing private fault-injection operations. */
export function createNodeScaffoldFilesystem(
  assertSchema: ScaffoldSchemaValidator,
  createTransactions: ScaffoldTransactionProvider
) {
  return {
    applyAuthorityFilesystemScaffoldWithFaultInjection: (
      consumerRoot: string,
      plan: AuthorityScaffoldPlan,
      faultInjector?: ScaffoldAuthorityFaultInjector
    ) => apply(consumerRoot, plan, faultInjector,
      createScaffoldFilesystemDependencies(assertSchema, createTransactions)),
    recoverAuthorityFilesystemScaffoldWithFaultInjection: (
      consumerRoot: string,
      scope?: AuthorityScaffoldRecoveryScope,
      faultInjector?: ScaffoldAuthorityFaultInjector
    ) => recover(consumerRoot, scope, faultInjector,
      createScaffoldFilesystemDependencies(assertSchema, createTransactions))
  };
}

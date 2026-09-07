import { pathTraversesSymbolicLink } from "../../source-inventory/node.js";
import { parseStrictYamlSource } from "../../features/configuration-input/yaml.js";
import { installedFoundationVersion } from "../../transaction-coordination/adapters/node/installed-foundation-version.js";
import { resolveInstalledFoundationTransactionArtifacts } from "../../transaction-coordination/adapters/node/installed-foundation-transaction-artifacts.js";
import { legacyFoundationEnvelopeSha256Json } from "../../transaction-coordination/adapters/node/legacy-document-envelope-v2.js";
import { assertEnvelopeDigests } from "../../transaction-coordination/adapters/node/legacy-envelope-digests.js";
import type { ScaffoldAuthorityObservation } from "../application/ports/authority-observation.js";
import type { ScaffoldLegacyDigests, ScaffoldTransactionArtifacts } from "../application/ports/transaction-observation.js";
import type { ScaffoldAuthorityDependencies } from "../adapters/node/scaffold-authority-dependencies.js";
import {
  inspectCurrentScaffoldingRecord as inspectCurrent,
  inspectLegacyScaffoldingEnvelope as inspectEnvelope,
  inspectLegacyScaffoldingJournal as inspectJournal
} from "../adapters/node/scaffold-transaction-status.js";
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
    assessPlanAuthority: (root, plan) => assessScaffoldPlanAuthority(root, plan, assertSchema, scaffoldAuthorityDependencies),
    createJournalStore: (root, operations) => new NodeScaffoldJournalStore(root, assertSchema, scaffoldTransactionArtifacts, operations),
    createTransactions
  };
}

export function createNodeScaffoldingApi(
  assertSchema: ScaffoldSchemaValidator,
  createTransactions: ScaffoldTransactionProvider
): ScaffoldingApi {
  const filesystem = createScaffoldFilesystemDependencies(assertSchema, createTransactions);
  return createScaffoldingApi({
    planScaffoldFromFile: (options) => planAuthorityScaffoldFromFile(options, assertSchema, scaffoldAuthorityDependencies),
    applyFilesystemScaffold: (root, plan) => apply(root, plan, undefined, filesystem),
    recoverFilesystemScaffold: (root, scope) => recover(root, scope, undefined, filesystem),
    readScaffoldPlanFile: (root, path) => readAuthorityScaffoldPlanFile(root, path, assertSchema, scaffoldAuthorityObservation),
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

/** Existing implementations are selected once, without performing observations eagerly. */
export const scaffoldAuthorityObservation: ScaffoldAuthorityObservation = {
  parseYaml: parseStrictYamlSource,
  pathTraversesSymbolicLink
};
export const scaffoldAuthorityDependencies: ScaffoldAuthorityDependencies = {
  observation: scaffoldAuthorityObservation,
  installedVersion: installedFoundationVersion,
  createRegistry: createAuthorityScaffoldRegistry
};
export const scaffoldTransactionArtifacts: ScaffoldTransactionArtifacts = resolveInstalledFoundationTransactionArtifacts;
export const scaffoldLegacyDigests: ScaffoldLegacyDigests = {
  journalPlanDigest: legacyFoundationEnvelopeSha256Json,
  assertEnvelopeDigests
};

export function inspectCurrentScaffoldingRecord(input: Parameters<typeof inspectCurrent>[0]) {
  return inspectCurrent(input, scaffoldTransactionArtifacts);
}
export function inspectLegacyScaffoldingJournal(input: Parameters<typeof inspectJournal>[0], assertSchema: ScaffoldSchemaValidator) {
  return inspectJournal(input, assertSchema, scaffoldLegacyDigests);
}
export function inspectLegacyScaffoldingEnvelope(value: Parameters<typeof inspectEnvelope>[0], assertSchema: ScaffoldSchemaValidator) {
  return inspectEnvelope(value, assertSchema, scaffoldLegacyDigests);
}

export { runScaffoldingCliCommand } from "../adapters/inbound/scaffolding-cli-command.js";

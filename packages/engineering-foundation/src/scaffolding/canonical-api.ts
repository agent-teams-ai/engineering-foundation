import type {
  ScaffoldAuthorityEvidence,
  ScaffoldPlan,
  ScaffoldRecoveryScope,
  ScaffoldReceipt
} from "./contract/scaffold-contract.js";
import {
  applyAuthorityFilesystemScaffoldWithFaultInjection as applyAuthorityFilesystemScaffold,
  recoverAuthorityFilesystemScaffoldWithFaultInjection as recoverAuthorityFilesystemScaffold
} from "../composition/scaffold-filesystem.js";
import { readAuthorityScaffoldPlanFile } from "./adapters/node/node-authority-input-loader.js";
import { validateAuthorityScaffoldReceipt } from "./adapters/node/node-authority-receipt-validator.js";
import {
  assertScaffoldAuthorityEvidenceDigest as assertAuthorityEvidenceDigest
} from "./kernel/authority-evidence.js";
import { assertAuthorityScaffoldPlanDigest } from "./kernel/plan-validation.js";
import { assertAuthorityScaffoldReceiptDigest } from "./adapters/inbound/authority-scaffold-receipt.js";
import { snapshotAuthorityScaffoldRecoveryScope } from "./kernel/recovery-scope.js";
import { ScaffoldError } from "./scaffold-error.js";
import { planAuthorityScaffoldFromFile } from "./adapters/inbound/plan-authority-scaffold-from-file.js";

export async function planScaffoldFromFile(options: {
  readonly consumerRoot: string;
  readonly intentPath: string;
  readonly configPath?: string;
}): Promise<ScaffoldPlan> {
  return planAuthorityScaffoldFromFile(options);
}

export async function applyFilesystemScaffold(
  consumerRoot: string,
  plan: ScaffoldPlan
): Promise<ScaffoldReceipt> {
  return applyAuthorityFilesystemScaffold(consumerRoot, plan);
}

export function recoverFilesystemScaffold(
  consumerRoot: string
): Promise<ScaffoldReceipt | undefined>;
export function recoverFilesystemScaffold(
  consumerRoot: string,
  scope: ScaffoldRecoveryScope
): Promise<ScaffoldReceipt | undefined>;
export async function recoverFilesystemScaffold(
  consumerRoot: string,
  ...scopeArgument: readonly [] | readonly [scope: ScaffoldRecoveryScope]
): Promise<ScaffoldReceipt | undefined> {
  if (scopeArgument.length > 1) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Scaffolding recovery accepts at most one recovery scope."
    );
  }
  const snapshot = scopeArgument.length === 0
    ? undefined
    : snapshotAuthorityScaffoldRecoveryScope(scopeArgument[0]);
  return recoverAuthorityFilesystemScaffold(consumerRoot, snapshot);
}

export async function readScaffoldPlanFile(
  consumerRoot: string,
  planPath: string
): Promise<ScaffoldPlan> {
  return readAuthorityScaffoldPlanFile(consumerRoot, planPath);
}

export async function validateScaffoldReceipt(
  receipt: unknown,
  plan?: ScaffoldPlan
): Promise<ScaffoldReceipt> {
  return validateAuthorityScaffoldReceipt(receipt, plan);
}

export function assertScaffoldPlanDigest(plan: ScaffoldPlan): void {
  assertAuthorityScaffoldPlanDigest(plan);
}

export function assertScaffoldReceiptDigest(
  receipt: ScaffoldReceipt,
  plan?: ScaffoldPlan
): void {
  assertAuthorityScaffoldReceiptDigest(receipt, plan);
}

export function assertScaffoldAuthorityEvidenceDigest(
  evidence: ScaffoldAuthorityEvidence
): void {
  assertAuthorityEvidenceDigest(evidence);
}

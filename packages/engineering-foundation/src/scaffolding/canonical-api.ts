import type {
  ScaffoldAuthorityEvidence,
  ScaffoldPlan,
  ScaffoldRecoveryScope,
  ScaffoldReceipt
} from "./contract/scaffold-contract.js";
import {
  applyAuthorityFilesystemScaffold
} from "./adapters/node/filesystem-authority-workspace.js";
import { recoverAuthorityFilesystemScaffold } from "./adapters/node/filesystem-authority-recovery.js";
import { readAuthorityScaffoldPlanFile } from "./adapters/node/node-authority-input-loader.js";
import { validateAuthorityScaffoldReceipt } from "./adapters/node/node-authority-receipt-validator.js";
import {
  assertScaffoldAuthorityEvidenceDigest as assertAuthorityEvidenceDigest
} from "./kernel/authority-evidence.js";
import { assertAuthorityScaffoldPlanDigest } from "./kernel/plan-validation.js";
import { assertAuthorityScaffoldReceiptDigest } from "./kernel/authority-receipt.js";
import { snapshotAuthorityScaffoldRecoveryScope } from "./kernel/recovery-scope.js";
import { planAuthorityScaffoldFromFile } from "./authority-service.js";

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
  const [scope] = scopeArgument;
  const snapshot = scope === undefined
    ? undefined
    : snapshotAuthorityScaffoldRecoveryScope(scope);
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

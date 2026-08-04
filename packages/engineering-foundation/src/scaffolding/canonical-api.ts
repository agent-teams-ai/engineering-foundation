import type {
  ScaffoldAuthorityEvidence,
  ScaffoldPlan,
  ScaffoldReceipt
} from "./contract/scaffold-contract.js";
import {
  applyAuthorityFilesystemScaffold,
  recoverAuthorityFilesystemScaffold
} from "./adapters/node/filesystem-authority-workspace.js";
import { readAuthorityScaffoldPlanFile } from "./adapters/node/node-authority-input-loader.js";
import { validateAuthorityScaffoldReceipt } from "./adapters/node/node-authority-receipt-validator.js";
import {
  assertScaffoldAuthorityEvidenceDigest as assertAuthorityEvidenceDigest
} from "./kernel/authority-evidence.js";
import { assertAuthorityScaffoldPlanDigest } from "./kernel/plan-validation.js";
import { assertAuthorityScaffoldReceiptDigest } from "./kernel/authority-receipt.js";
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

export async function recoverFilesystemScaffold(
  consumerRoot: string
): Promise<ScaffoldReceipt | undefined> {
  return recoverAuthorityFilesystemScaffold(consumerRoot);
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

import type {
  ScaffoldAuthorityEvidence,
  ScaffoldPlan,
  ScaffoldRecoveryScope,
  ScaffoldReceipt
} from "../scaffolding/contract/scaffold-contract.js";
import { createNodeScaffoldingApi } from "../scaffolding/composition/node-scaffolding.js";
import { assertSchema } from "../schema-catalog.js";
import { createScaffoldTransactions } from "./scaffold-filesystem.js";

export const scaffoldingApi = createNodeScaffoldingApi(assertSchema, createScaffoldTransactions);

export async function planScaffoldFromFile(options: {
  readonly consumerRoot: string;
  readonly intentPath: string;
  readonly configPath?: string;
}): Promise<ScaffoldPlan> {
  return scaffoldingApi.planScaffoldFromFile(options);
}

export async function applyFilesystemScaffold(
  consumerRoot: string,
  plan: ScaffoldPlan
): Promise<ScaffoldReceipt> {
  return scaffoldingApi.applyFilesystemScaffold(consumerRoot, plan);
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
  return scaffoldingApi.recoverFilesystemScaffold(consumerRoot, ...scopeArgument);
}

export async function readScaffoldPlanFile(
  consumerRoot: string,
  planPath: string
): Promise<ScaffoldPlan> {
  return scaffoldingApi.readScaffoldPlanFile(consumerRoot, planPath);
}

export async function validateScaffoldReceipt(
  receipt: unknown,
  plan?: ScaffoldPlan
): Promise<ScaffoldReceipt> {
  return scaffoldingApi.validateScaffoldReceipt(receipt, plan);
}

export function assertScaffoldPlanDigest(plan: ScaffoldPlan): void {
  scaffoldingApi.assertScaffoldPlanDigest(plan);
}

export function assertScaffoldReceiptDigest(
  receipt: ScaffoldReceipt,
  plan?: ScaffoldPlan
): void {
  scaffoldingApi.assertScaffoldReceiptDigest(receipt, plan);
}

export function assertScaffoldAuthorityEvidenceDigest(
  evidence: ScaffoldAuthorityEvidence
): void {
  scaffoldingApi.assertScaffoldAuthorityEvidenceDigest(evidence);
}

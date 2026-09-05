import { createFoundationModeInspection } from "../local-mode/node.js";
import type { FoundationStatus, FoundationTransactionAwareStatus } from "../local-mode/api.js";
import { inspectInstalledFoundationTransaction } from "../transaction-coordination/node.js";
import { createFoundationTransactionInspection } from "./foundation-transaction-inspection.js";

function inspectTransaction(consumerRoot: string) {
  return inspectInstalledFoundationTransaction(consumerRoot, createFoundationTransactionInspection);
}
const inspection = createFoundationModeInspection(inspectTransaction);

export async function inspectFoundationMode(consumerPath: string, options?: { readonly ignoreOperationLock?: boolean }): Promise<FoundationStatus> {
  return inspection.inspectFoundationMode(consumerPath, options);
}
export async function inspectFoundationTransactionAwareMode(consumerPath: string, options?: { readonly ignoreOperationLock?: boolean }): Promise<FoundationTransactionAwareStatus> {
  return inspection.inspectFoundationTransactionAwareMode(consumerPath, options);
}

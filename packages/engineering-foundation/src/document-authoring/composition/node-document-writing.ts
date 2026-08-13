import type { DocumentReceipt } from "../application/model/document-receipt.js";
import type { ApplyDocumentPlanRequest } from "../application/use-cases/apply-document-plan.js";
import type { RecoverDocumentTransactionRequest } from "../application/use-cases/recover-document-transaction.js";
import {
  applyNodeDocumentationPlanPrivately,
  recoverNodeDocumentationTransactionPrivately
} from "./node-document-writing-private.js";

/** Closed Node composition for durable, create-only document publication. */
export async function applyNodeDocumentationPlan(
  request: ApplyDocumentPlanRequest
): Promise<DocumentReceipt> {
  return applyNodeDocumentationPlanPrivately(request);
}

/** Closed Node composition for exact-version document transaction recovery. */
export async function recoverNodeDocumentationTransaction(
  request: RecoverDocumentTransactionRequest
): Promise<DocumentReceipt> {
  return recoverNodeDocumentationTransactionPrivately(request);
}

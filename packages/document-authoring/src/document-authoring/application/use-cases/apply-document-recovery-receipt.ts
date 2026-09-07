import type { DocumentPlanContract as DocumentPlan } from "../model/document-planning.js";
import type { DocumentReceiptContract as DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentOwnedTemporary } from "../model/document-transaction.js";
import type {
  ApplyDocumentPlanDependencies,
  ApplyDocumentPlanRequest
} from "./apply-document-plan.js";
import type { ActiveDocumentJournal } from "./document-transaction-continuation.js";
import { recoveryReceipt } from "./document-transaction-receipts.js";
import { recaptureDirectoryReceiptEvidence } from "./recapture-directory-receipt-evidence.js";

export interface ApplyExecutionState {
  active?: ActiveDocumentJournal;
  publicationPossible: boolean;
  retainTransactionBarrier: boolean;
  temporary?: DocumentOwnedTemporary;
}

export async function applyRecoveryReceipt(
  dependencies: ApplyDocumentPlanDependencies,
  request: ApplyDocumentPlanRequest,
  plan: DocumentPlan,
  state: ApplyExecutionState,
  options: Parameters<typeof recoveryReceipt>[2]
): Promise<DocumentReceipt> {
  const captured = state.active === undefined
    ? { current: true as const }
    : await recaptureDirectoryReceiptEvidence(
        dependencies.parentMaterializer,
        request.consumerRoot,
        state.active
      );
  if (!captured.current) {
    state.retainTransactionBarrier = true;
  }
  return recoveryReceipt(dependencies.schema, plan, {
    ...options,
    ...(captured.evidence === undefined
      ? {}
      : { directoryEvidence: captured.evidence })
  });
}

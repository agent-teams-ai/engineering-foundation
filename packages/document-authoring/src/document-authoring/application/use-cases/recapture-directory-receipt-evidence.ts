import type { DocumentParentMaterializerV2 } from "../ports/document-parent-materializer.js";
import type { ActiveDocumentJournal } from "./document-transaction-continuation.js";
import {
  directoryReceiptEvidence,
  type DocumentDirectoryReceiptEvidence
} from "./document-transaction-receipts.js";

export async function recaptureDirectoryReceiptEvidence(
  parentMaterializer: DocumentParentMaterializerV2,
  consumerRoot: string,
  active: ActiveDocumentJournal
): Promise<{
  readonly current: boolean;
  readonly evidence?: DocumentDirectoryReceiptEvidence;
}> {
  const evidence = directoryReceiptEvidence(active.envelope);
  if (active.envelope.schemaVersion !== 4 || evidence === undefined) {
    return { current: true, ...(evidence === undefined ? {} : { evidence }) };
  }
  try {
    const inspection = await parentMaterializer.inspect({
      consumerRoot,
      journal: {
        anchorIdentity: active.envelope.journal.parentMaterialization.anchorIdentity,
        createdDirectories: active.envelope.journal.parentMaterialization.createdDirectories,
        plan: active.envelope.journal.plan.parentMaterialization,
        schemaVersion: 2
      }
    });
    if (inspection.state === "current") {
      return { current: true, evidence };
    }
  } catch {
    // Unsafe or unavailable filesystem evidence is intentionally downgraded.
  }
  return {
    current: false,
    evidence: {
      observedCreatedDirectories: evidence.observedCreatedDirectories,
      state: "preserved-unknown"
    }
  };
}

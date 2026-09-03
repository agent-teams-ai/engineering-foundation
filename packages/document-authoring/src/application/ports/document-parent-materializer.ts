import type {
  DocumentCreatedDirectoryEvidenceV2,
  DocumentParentMaterializationInspectionV2,
  DocumentParentMaterializationJournalV2,
  DocumentParentMaterializationPlanV2
} from "../model/document-parent-materialization.js";
import type { DocumentPhysicalIdentity } from "../model/document-physical-identity.js";

export interface DocumentParentMaterializerV2 {
  begin(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentParentMaterializationPlanV2;
  }): Promise<DocumentParentMaterializationJournalV2>;
  inspect(request: {
    readonly consumerRoot: string;
    readonly journal: DocumentParentMaterializationJournalV2;
  }): Promise<DocumentParentMaterializationInspectionV2>;
  createNext(request: {
    readonly consumerRoot: string;
    readonly journal: DocumentParentMaterializationJournalV2;
    readonly signal?: AbortSignal;
  }): Promise<DocumentCreatedDirectoryEvidenceV2 | undefined>;
  createAndBindOne(request: {
    readonly consumerRoot: string;
    readonly expectedParentIdentity: DocumentPhysicalIdentity;
    readonly path: string;
    readonly bindCreatedDirectory: (
      evidence: DocumentCreatedDirectoryEvidenceV2
    ) => Promise<void>;
  }): Promise<void>;
}

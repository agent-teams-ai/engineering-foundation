export type { DocumentAuthoringSchemaId } from "./application/ports/document-schema-validator.js";
export type {
  DocumentAuthorityDigest,
  DocumentAuthorityEvidence,
  DocumentDescriptor,
  DocumentDescriptorV2,
  DocumentIdentityProjectionEntry,
  DocumentationCatalogAuthority,
  DocumentationCatalogAuthorityV2,
  DocumentationCatalogDiagnostic,
  DocumentationCatalogSnapshot,
  DocumentationCatalogSnapshotV2,
  DocumentMetadataObject,
  DocumentMetadataPrimitive,
  DocumentMetadataValue,
  ReferencedDocumentProjection,
  ReferencedDocumentProjectionResult
} from "./application/model/document-catalog.js";
export type {
  DocumentFindFilters,
  DocumentFindQuery,
  DocumentFindResult
  ,DocumentFindResultV2
} from "./application/model/document-find.js";
export type {
  DocumentAuthoringProfileDescriptionV2,
  DocumentAuthoringProfileDescriptionV3,
  DocumentAuthoringTypeDescriptionV2,
  DocumentReachabilityStrategyV2
} from "./application/model/document-authoring-profile-description.js";
export type {
  DocumentCompilerIdentity,
  DocumentIntent,
  DocumentJsonObject,
  DocumentJsonPrimitive,
  DocumentJsonValue,
  DocumentCatalogCollection,
  DocumentIdentityStrategy,
  DocumentPlacementStrategy,
  DocumentPlan,
  DocumentPlanCommon,
  DocumentPlanContract,
  DocumentPlanV1,
  DocumentPlanV2,
  DocumentPlanDiagnostic,
  DocumentReachabilityStrategy
} from "./application/model/document-planning.js";
export type { DocumentPhysicalIdentity } from "./application/model/document-physical-identity.js";
export type {
  DocumentCreatedDirectoryEvidenceV2,
  DocumentParentMaterializationInspectionV2,
  DocumentParentMaterializationJournalV2,
} from "./application/model/document-parent-materialization.js";
export type { DocumentParentMaterializationPlanV2 } from "./application/model/document-parent-materialization.js";
export type {
  DocumentCommitObservation,
  DocumentReceipt,
  DocumentReceiptBase,
  DocumentReceiptDiagnostic,
  DocumentReceiptOutcome,
  DocumentReceiptV1,
  DocumentReceiptV2
  ,DocumentReceiptContract
} from "./application/model/document-receipt.js";
export type {
  DocumentTransactionInspectionDiagnostic,
  DocumentTransactionInspection,
  DocumentTransactionInspectionV1,
  DocumentTransactionInspectionV2
} from "./application/model/document-transaction-inspection.js";
export type {
  DocumentJournalBase,
  DocumentOwnedTemporary,
  DocumentTransactionEnvelope,
  DocumentTransactionEnvelopeBase,
  DocumentTransactionEnvelopeV3,
  DocumentTransactionEnvelopeV4,
  DocumentTransactionEnvelopeV4Base,
  DocumentTransactionJournal,
  DocumentTransactionJournalV3,
  DocumentTransactionJournalV3Base
} from "./application/model/document-transaction.js";
export type { ApplyDocumentPlanRequest } from "./application/use-cases/apply-document-plan.js";
export type { RecoverDocumentTransactionRequest } from "./application/use-cases/recover-document-transaction.js";
export type { DocumentTransactionRequest } from "./application/use-cases/document-transaction-continuation.js";
export type { BuildDocumentationCatalogRequest } from "./application/use-cases/build-documentation-catalog.js";
export type { FindDocumentsRequest } from "./application/use-cases/find-documents.js";
export type {
  DescribeDocumentAuthoringProfileV2Request,
  DescribeDocumentAuthoringProfileV3Request
} from "./application/model/document-description-authority.js";
export type { InspectDocumentAuthoringEnvironmentV1Request } from "./application/model/document-environment-request.js";
export type { DocumentEnvironmentInspection } from "./application/ports/document-environment-inspector.js";
export type {
  PlanDocumentationDocumentRequest,
  PlanDocumentationDocumentRequestContract,
  PlanDocumentationDocumentRequestV2
} from "./application/use-cases/plan-documentation-document.js";
export { projectReferencedDocuments } from "./application/projections/document-catalog-projections.js";
export { DocumentCatalogError } from "./application/model/document-catalog-error.js";
export type { DocumentCatalogErrorCode } from "./application/model/document-catalog-error.js";
export { DocumentPlanningError } from "./application/model/document-planning-error.js";
export type { DocumentPlanningErrorCode } from "./application/model/document-planning-error.js";

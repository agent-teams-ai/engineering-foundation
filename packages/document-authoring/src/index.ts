import { FilesystemMarkdownRepository } from "./documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { NodeAuthoringProfileReader } from "./adapters/node/node-authoring-profile-reader.js";
import { NodeAuthoringProfileReaderV2 } from "./adapters/node/node-authoring-profile-reader-v2.js";
import { NodeDocumentMetadataSidecarReader } from "./adapters/node/node-document-metadata-sidecar-reader.js";
import { NodeMetadataInstanceValidator } from "./adapters/node/node-metadata-instance-validator.js";
import { NodeOwnerMembershipReader } from "./adapters/node/node-owner-membership-reader.js";
import {
  BuildDocumentationCatalog,
  BuildDocumentationCatalogV2,
  type BuildDocumentationCatalogRequest
} from "./application/use-cases/build-documentation-catalog.js";
import {
  FindDocuments,
  FindDocumentsV2,
  type FindDocumentsRequest
} from "./application/use-cases/find-documents.js";
import type {
  PlanDocumentationDocumentRequestContract,
  PlanDocumentationDocumentRequestV2
} from "./application/use-cases/plan-documentation-document.js";
import type { DocumentPlanContract } from "./application/model/document-planning.js";
import type { DocumentReceiptContract } from "./application/model/document-receipt.js";
import { planNodeDocumentationDocument } from "./composition/node-document-planning.js";
import type { ApplyDocumentPlanRequest } from "./application/use-cases/apply-document-plan.js";
import type { RecoverDocumentTransactionRequest } from "./application/use-cases/recover-document-transaction.js";
import {
  applyNodeDocumentationPlan,
  recoverNodeDocumentationTransaction
} from "./composition/node-document-writing.js";
import {
  describeDocumentAuthoringProfileV2,
  describeDocumentAuthoringProfileV3
} from "./composition/describe-document-authoring-profile-v2.js";
import { inspectDocumentAuthoringEnvironmentV1 } from "./composition/inspect-document-authoring-environment-v1.js";
export { readDocumentAuthoringSchema } from "./schema-catalog.js";
export type { DocumentAuthoringSchemaId } from "./schema-catalog.js";

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
/**
 * @deprecated Qualification-only low-level planner model. Import from
 * `@agent-teams/document-authoring/qualification`.
 */
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
} from "./composition/describe-document-authoring-profile-v2.js";
export type { InspectDocumentAuthoringEnvironmentV1Request } from "./composition/inspect-document-authoring-environment-v1.js";
export type { DocumentEnvironmentInspection } from "./application/ports/document-environment-inspector.js";
export type {
  PlanDocumentationDocumentRequest,
  PlanDocumentationDocumentRequestContract,
  PlanDocumentationDocumentRequestV2
} from "./application/use-cases/plan-documentation-document.js";
export { projectReferencedDocuments } from "./application/projections/document-catalog-projections.js";
export { DocumentCatalogError } from "./document-catalog-error.js";
export type { DocumentCatalogErrorCode } from "./document-catalog-error.js";
export { DocumentPlanningError } from "./document-planning-error.js";
export type { DocumentPlanningErrorCode } from "./document-planning-error.js";
export {
  inspectDocumentTransactionV1,
  inspectDocumentTransactionV2
} from "./composition/inspect-document-transaction.js";
export { describeDocumentAuthoringProfileV2 };
export { describeDocumentAuthoringProfileV3 };
export { inspectDocumentAuthoringEnvironmentV1 };
export {
  planDocumentParentMaterializationV2
} from "./adapters/node/node-document-parent-materializer.js";

export async function buildDocumentationCatalog(
  request: BuildDocumentationCatalogRequest
) {
  const builder = new BuildDocumentationCatalog({
    metadata: new NodeMetadataInstanceValidator(),
    owners: new NodeOwnerMembershipReader(),
    profile: new NodeAuthoringProfileReader(),
    repository: new FilesystemMarkdownRepository()
  });
  return builder.execute(request);
}

export async function buildDocumentationCatalogV2(
  request: BuildDocumentationCatalogRequest
) {
  const builder = new BuildDocumentationCatalogV2({
    metadata: new NodeMetadataInstanceValidator(),
    owners: new NodeOwnerMembershipReader(),
    profile: new NodeAuthoringProfileReaderV2(),
    repository: new FilesystemMarkdownRepository(),
    sidecar: new NodeDocumentMetadataSidecarReader()
  });
  return builder.execute(request);
}

export async function findDocumentationDocuments(request: FindDocumentsRequest) {
  const catalog = new BuildDocumentationCatalog({
    metadata: new NodeMetadataInstanceValidator(),
    owners: new NodeOwnerMembershipReader(),
    profile: new NodeAuthoringProfileReader(),
    repository: new FilesystemMarkdownRepository()
  });
  return new FindDocuments(catalog).execute(request);
}

export async function findDocumentationDocumentsV2(request: FindDocumentsRequest) {
  const catalog = new BuildDocumentationCatalogV2({
    metadata: new NodeMetadataInstanceValidator(),
    owners: new NodeOwnerMembershipReader(),
    profile: new NodeAuthoringProfileReaderV2(),
    repository: new FilesystemMarkdownRepository(),
    sidecar: new NodeDocumentMetadataSidecarReader()
  });
  return new FindDocumentsV2(catalog).execute(request);
}

/**
 * Compiles a deterministic Document Plan without reserving an identity or
 * mutating the consumer repository. Narrow schemaVersion before using fields
 * specific to either Plan generation.
 */
export async function planDocumentationDocument(
  request: PlanDocumentationDocumentRequestContract
): Promise<DocumentPlanContract> {
  return planNodeDocumentationDocument(request);
}

/** Compiles the directory-materializing Document Plan v2 contract. */
export async function planDocumentationDocumentV2(
  request: PlanDocumentationDocumentRequestV2
): Promise<import("./application/model/document-planning.js").DocumentPlanV2> {
  const plan = await planNodeDocumentationDocument(request);
  if (plan.schemaVersion !== 2) {
    throw new TypeError(
      "Document Plan v2 entrypoint received a legacy planning result."
    );
  }
  return plan;
}

/** Applies one exact Plan; the Receipt generation follows the validated Plan. */
export async function applyDocumentationPlan(
  request: ApplyDocumentPlanRequest
): Promise<DocumentReceiptContract> {
  return applyNodeDocumentationPlan(request);
}

/** Applies one exact Document Plan v2 through envelope v4. */
export async function applyDocumentationPlanV2(
  request: Omit<ApplyDocumentPlanRequest, "plan"> & {
    readonly plan: import("./application/model/document-planning.js").DocumentPlanV2;
  }
): Promise<import("./application/model/document-receipt.js").DocumentReceiptV2> {
  const receipt = await applyNodeDocumentationPlan(request);
  if (receipt.schemaVersion !== 2) {
    throw new TypeError("Document Plan v2 produced a legacy Receipt.");
  }
  return receipt;
}

/** Recovers one qualified transaction; persisted evidence selects its generation. */
export async function recoverDocumentationTransaction(
  request: RecoverDocumentTransactionRequest
): Promise<DocumentReceiptContract> {
  return recoverNodeDocumentationTransaction(request);
}

/** Recovers either exact supported document transaction generation. */
export async function recoverDocumentationTransactionV2(
  request: RecoverDocumentTransactionRequest
): Promise<DocumentReceiptContract> {
  return recoverNodeDocumentationTransaction(request);
}

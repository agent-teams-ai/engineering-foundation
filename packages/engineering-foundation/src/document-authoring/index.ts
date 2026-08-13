import { FilesystemMarkdownRepository } from "../documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { NodeAuthoringProfileReader } from "./adapters/node/node-authoring-profile-reader.js";
import { NodeMetadataInstanceValidator } from "./adapters/node/node-metadata-instance-validator.js";
import { NodeOwnerMembershipReader } from "./adapters/node/node-owner-membership-reader.js";
import {
  BuildDocumentationCatalog,
  type BuildDocumentationCatalogRequest
} from "./application/use-cases/build-documentation-catalog.js";
import {
  FindDocuments,
  type FindDocumentsRequest
} from "./application/use-cases/find-documents.js";
import type { PlanDocumentationDocumentRequest } from "./application/use-cases/plan-documentation-document.js";
import { planNodeDocumentationDocument } from "./composition/node-document-planning.js";
import type { ApplyDocumentPlanRequest } from "./application/use-cases/apply-document-plan.js";
import type { RecoverDocumentTransactionRequest } from "./application/use-cases/recover-document-transaction.js";
import {
  applyNodeDocumentationPlan,
  recoverNodeDocumentationTransaction
} from "./composition/node-document-writing.js";

export type {
  DocumentAuthorityDigest,
  DocumentAuthorityEvidence,
  DocumentDescriptor,
  DocumentIdentityProjectionEntry,
  DocumentationCatalogAuthority,
  DocumentationCatalogDiagnostic,
  DocumentationCatalogSnapshot,
  ReferencedDocumentProjection,
  ReferencedDocumentProjectionResult
} from "./application/model/document-catalog.js";
export type {
  DocumentFindFilters,
  DocumentFindQuery,
  DocumentFindResult
} from "./application/model/document-find.js";
export type {
  DocumentCompilerIdentity,
  DocumentIntent,
  DocumentJsonObject,
  DocumentJsonPrimitive,
  DocumentJsonValue,
  DocumentPlan,
  DocumentPlanDiagnostic
} from "./application/model/document-planning.js";
export type {
  DocumentCommitObservation,
  DocumentReceipt,
  DocumentReceiptBase,
  DocumentReceiptDiagnostic,
  DocumentReceiptOutcome
} from "./application/model/document-receipt.js";
export type {
  DocumentTransactionInspectionDiagnostic,
  DocumentTransactionInspectionV1
} from "./application/model/document-transaction-inspection.js";
export type { ApplyDocumentPlanRequest } from "./application/use-cases/apply-document-plan.js";
export type { RecoverDocumentTransactionRequest } from "./application/use-cases/recover-document-transaction.js";
export type { DocumentTransactionRequest } from "./application/use-cases/document-transaction-continuation.js";
export type { BuildDocumentationCatalogRequest } from "./application/use-cases/build-documentation-catalog.js";
export type { FindDocumentsRequest } from "./application/use-cases/find-documents.js";
export type { PlanDocumentationDocumentRequest } from "./application/use-cases/plan-documentation-document.js";
export { projectReferencedDocuments } from "./application/projections/document-catalog-projections.js";
export { DocumentCatalogError } from "./document-catalog-error.js";
export type { DocumentCatalogErrorCode } from "./document-catalog-error.js";
export { DocumentPlanningError } from "./document-planning-error.js";
export type { DocumentPlanningErrorCode } from "./document-planning-error.js";
export { inspectDocumentTransactionV1 } from "./composition/inspect-document-transaction.js";

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

export async function findDocumentationDocuments(request: FindDocumentsRequest) {
  const catalog = new BuildDocumentationCatalog({
    metadata: new NodeMetadataInstanceValidator(),
    owners: new NodeOwnerMembershipReader(),
    profile: new NodeAuthoringProfileReader(),
    repository: new FilesystemMarkdownRepository()
  });
  return new FindDocuments(catalog).execute(request);
}

/**
 * Compiles a deterministic Document Plan without reserving an identity or
 * mutating the consumer repository.
 */
export async function planDocumentationDocument(
  request: PlanDocumentationDocumentRequest
) {
  return planNodeDocumentationDocument(request);
}

/** Applies one exact Document Plan through the durable create-only writer. */
export async function applyDocumentationPlan(
  request: ApplyDocumentPlanRequest
): Promise<import("./application/model/document-receipt.js").DocumentReceipt> {
  return applyNodeDocumentationPlan(request);
}

/** Recovers one coordinator-qualified document transaction. */
export async function recoverDocumentationTransaction(
  request: RecoverDocumentTransactionRequest
): Promise<import("./application/model/document-receipt.js").DocumentReceipt> {
  return recoverNodeDocumentationTransaction(request);
}

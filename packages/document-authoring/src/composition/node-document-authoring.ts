import type {
  ApplyDocumentPlanRequest,
  BuildDocumentationCatalogRequest,
  DescribeDocumentAuthoringProfileV2Request,
  DescribeDocumentAuthoringProfileV3Request,
  DocumentAuthoringProfileDescriptionV2,
  DocumentAuthoringProfileDescriptionV3,
  DocumentEnvironmentInspection,
  DocumentFindResult,
  DocumentFindResultV2,
  DocumentPlanContract,
  DocumentPlanV2,
  DocumentReceiptContract,
  DocumentReceiptV2,
  DocumentationCatalogSnapshot,
  DocumentationCatalogSnapshotV2,
  FindDocumentsRequest,
  InspectDocumentAuthoringEnvironmentV1Request,
  PlanDocumentationDocumentRequestContract,
  PlanDocumentationDocumentRequestV2,
  RecoverDocumentTransactionRequest
} from "../document-authoring/api.js";
import { FilesystemMarkdownRepository, readContainedRegularFile, readMarkdownSyntax } from "../documentation-observation/module.js";
import { createNodeDocumentAuthoring } from "../document-authoring/module.js";

const documentAuthoring = createNodeDocumentAuthoring({
  repository: new FilesystemMarkdownRepository(),
  readFile: readContainedRegularFile,
  syntax: readMarkdownSyntax
});

export function buildDocumentationCatalog(request: BuildDocumentationCatalogRequest): Promise<DocumentationCatalogSnapshot> {
  return documentAuthoring.buildDocumentationCatalog(request);
}

export function buildDocumentationCatalogV2(request: BuildDocumentationCatalogRequest): Promise<DocumentationCatalogSnapshotV2> {
  return documentAuthoring.buildDocumentationCatalogV2(request);
}

export function findDocumentationDocuments(request: FindDocumentsRequest): Promise<DocumentFindResult> {
  return documentAuthoring.findDocumentationDocuments(request);
}

export function findDocumentationDocumentsV2(request: FindDocumentsRequest): Promise<DocumentFindResultV2> {
  return documentAuthoring.findDocumentationDocumentsV2(request);
}

export function planDocumentationDocument(request: PlanDocumentationDocumentRequestContract): Promise<DocumentPlanContract> {
  return documentAuthoring.planDocumentationDocument(request);
}

export function planDocumentationDocumentV2(request: PlanDocumentationDocumentRequestV2): Promise<DocumentPlanV2> {
  return documentAuthoring.planDocumentationDocumentV2(request);
}

export function applyDocumentationPlan(request: ApplyDocumentPlanRequest): Promise<DocumentReceiptContract> {
  return documentAuthoring.applyDocumentationPlan(request);
}

export function applyDocumentationPlanV2(request: Omit<ApplyDocumentPlanRequest, "plan"> & {
  readonly plan: DocumentPlanV2;
}): Promise<DocumentReceiptV2> {
  return documentAuthoring.applyDocumentationPlanV2(request);
}

export function recoverDocumentationTransaction(request: RecoverDocumentTransactionRequest): Promise<DocumentReceiptContract> {
  return documentAuthoring.recoverDocumentationTransaction(request);
}

export function recoverDocumentationTransactionV2(request: RecoverDocumentTransactionRequest): Promise<DocumentReceiptContract> {
  return documentAuthoring.recoverDocumentationTransactionV2(request);
}

export function describeDocumentAuthoringProfileV2(request: DescribeDocumentAuthoringProfileV2Request): Promise<DocumentAuthoringProfileDescriptionV2> {
  return documentAuthoring.describeDocumentAuthoringProfileV2(request);
}

export function describeDocumentAuthoringProfileV3(request: DescribeDocumentAuthoringProfileV3Request): Promise<DocumentAuthoringProfileDescriptionV3> {
  return documentAuthoring.describeDocumentAuthoringProfileV3(request);
}

export function inspectDocumentAuthoringEnvironmentV1(request: InspectDocumentAuthoringEnvironmentV1Request): Promise<DocumentEnvironmentInspection> {
  return documentAuthoring.inspectDocumentAuthoringEnvironmentV1(request);
}

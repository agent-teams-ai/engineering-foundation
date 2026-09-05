import { FilesystemMarkdownRepository, readContainedRegularFile, readMarkdownSyntax } from "../documentation-observation/module.js";
import { createNodeDocumentAuthoring } from "../document-authoring/module.js";
export const {
  buildDocumentationCatalog,
  buildDocumentationCatalogV2,
  findDocumentationDocuments,
  findDocumentationDocumentsV2,
  planDocumentationDocument,
  planDocumentationDocumentV2,
  applyDocumentationPlan,
  applyDocumentationPlanV2,
  recoverDocumentationTransaction,
  recoverDocumentationTransactionV2,
  describeDocumentAuthoringProfileV2,
  describeDocumentAuthoringProfileV3,
  inspectDocumentAuthoringEnvironmentV1
} = createNodeDocumentAuthoring({ repository: new FilesystemMarkdownRepository(), readFile: readContainedRegularFile, syntax: readMarkdownSyntax });

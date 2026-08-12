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
export type { BuildDocumentationCatalogRequest } from "./application/use-cases/build-documentation-catalog.js";
export type { FindDocumentsRequest } from "./application/use-cases/find-documents.js";
export { projectReferencedDocuments } from "./application/projections/document-catalog-projections.js";
export { DocumentCatalogError } from "./document-catalog-error.js";
export type { DocumentCatalogErrorCode } from "./document-catalog-error.js";

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

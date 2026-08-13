import { FilesystemMarkdownRepository } from "../documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { installedFoundationVersion } from "../package-version.js";
import { installedFoundationBuildIdentity } from "../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import {
  CanonicalMarkdownError,
  YamlCanonicalDocumentRenderer
} from "./adapters/canonical-markdown.js";
import { NodeAuthoringProfileReader } from "./adapters/node/node-authoring-profile-reader.js";
import { NodeDocumentContractValidator } from "./adapters/node/node-document-contract-validator.js";
import { NodeDocumentPlanningProfileReader } from "./adapters/node/node-document-planning-profile-reader.js";
import { NodeDocumentPlanningStateReader } from "./adapters/node/node-document-planning-state-reader.js";
import { NodeDocumentTemplateReader } from "./adapters/node/node-document-template-reader.js";
import { NodeMetadataInstanceValidator } from "./adapters/node/node-metadata-instance-validator.js";
import { NodeOwnerMembershipReader } from "./adapters/node/node-owner-membership-reader.js";
import { DocumentPlanningPolicyError } from "./application/policies/document-planning-policy-error.js";
import {
  classifyDocumentLogicalPreimage,
  isDestinationCoveredByCatalog
} from "./application/policies/document-logical-preimage.js";
import { normalizeDocumentIntent } from "./application/policies/normalize-document-intent.js";
import {
  resolveDocumentAuthoring,
  selectDocumentArtifact
} from "./application/policies/resolve-document-authoring.js";
import {
  BuildDocumentationCatalog,
  type BuildDocumentationCatalogRequest
} from "./application/use-cases/build-documentation-catalog.js";
import {
  FindDocuments,
  type FindDocumentsRequest
} from "./application/use-cases/find-documents.js";
import {
  PlanDocumentationDocument,
  type PlanDocumentationDocumentRequest
} from "./application/use-cases/plan-documentation-document.js";
import { DocumentPlanningError } from "./document-planning-error.js";

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
  DocumentIntent,
  DocumentPlan,
  DocumentPlanDiagnostic
} from "./application/model/document-planning.js";
export type { BuildDocumentationCatalogRequest } from "./application/use-cases/build-documentation-catalog.js";
export type { FindDocumentsRequest } from "./application/use-cases/find-documents.js";
export type { PlanDocumentationDocumentRequest } from "./application/use-cases/plan-documentation-document.js";
export { projectReferencedDocuments } from "./application/projections/document-catalog-projections.js";
export { DocumentCatalogError } from "./document-catalog-error.js";
export type { DocumentCatalogErrorCode } from "./document-catalog-error.js";
export { DocumentPlanningError } from "./document-planning-error.js";
export type { DocumentPlanningErrorCode } from "./document-planning-error.js";

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

function planningPolicyFailure(error: DocumentPlanningPolicyError): never {
  const code = error.problem === "catalog-incomplete"
    ? "DOCUMENT_PLANNING_CATALOG_PARTIAL"
    : ["catalog-collision", "destination-conflict"].includes(error.problem)
      ? "DOCUMENT_PLANNING_CONFLICT"
      : "DOCUMENT_PLANNING_INPUT_INVALID";
  throw new DocumentPlanningError(code, error.message, { cause: error });
}

/**
 * Compiles a deterministic Document Plan without reserving an identity or
 * mutating the consumer repository.
 */
export async function planDocumentationDocument(
  request: PlanDocumentationDocumentRequest
) {
  const catalog = new BuildDocumentationCatalog({
    metadata: new NodeMetadataInstanceValidator(),
    owners: new NodeOwnerMembershipReader(),
    profile: new NodeAuthoringProfileReader(),
    repository: new FilesystemMarkdownRepository()
  });
  const [version, buildIdentity] = await Promise.all([
    installedFoundationVersion(),
    installedFoundationBuildIdentity()
  ]);
  const planner = new PlanDocumentationDocument({
    catalog,
    compiler: {
      id: "@agent-teams/engineering-foundation",
      version,
      buildIdentity
    },
    contracts: new NodeDocumentContractValidator(),
    metadata: new NodeMetadataInstanceValidator(),
    owners: new NodeOwnerMembershipReader(),
    policies: {
      classifyDocumentLogicalPreimage,
      isDestinationCoveredByCatalog,
      normalizeDocumentIntent,
      resolveDocumentAuthoring,
      selectDocumentArtifact
    },
    profile: new NodeDocumentPlanningProfileReader(),
    renderer: new YamlCanonicalDocumentRenderer(),
    state: new NodeDocumentPlanningStateReader(),
    templates: new NodeDocumentTemplateReader()
  });
  try {
    return await planner.execute(request);
  } catch (error) {
    if (error instanceof DocumentPlanningPolicyError) {
      planningPolicyFailure(error);
    }
    if (error instanceof CanonicalMarkdownError) {
      throw new DocumentPlanningError(
        "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
        `Document template authority is invalid: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

import type { DescriptionRequest, LoadedDescriptionAuthority } from "../model/document-description-authority.js";
import type { DocumentAuthoringProfileDescriptionV2, DocumentAuthoringProfileDescriptionV3 } from "../model/document-authoring-profile-description.js";
import { projectDescription } from "../policies/project-document-authoring-description.js";
import { DocumentCatalogError } from "../model/document-catalog-error.js";
export type DocumentDescriptionAuthorityReader = (request: DescriptionRequest, version: 2 | 3) => Promise<LoadedDescriptionAuthority>;
export async function describeDocumentAuthoringProfile(
  request: DescriptionRequest,
  version: 2 | 3,
  loadDescriptionAuthority: DocumentDescriptionAuthorityReader
): Promise<DocumentAuthoringProfileDescriptionV2 | DocumentAuthoringProfileDescriptionV3> {
  const before = projectDescription(
    await loadDescriptionAuthority(request, version)
  );
  const after = projectDescription(
    await loadDescriptionAuthority(request, version)
  );
  if (before.semanticDigest !== after.semanticDigest) {
    throw new DocumentCatalogError(
      "DOCUMENT_CATALOG_AUTHORITY_CHANGED",
      "Document authoring profile authority changed while it was described."
    );
  }
  return after;
}


import type { DocumentAuthorityEvidence } from "../model/document-catalog.js";
import type { CatalogProfileSnapshot } from "../ports/authoring-profile-reader.js";
import type { DocumentMetadataSidecarSnapshot } from "../ports/document-metadata-sidecar-reader.js";
import type { MetadataSchemaSnapshot } from "../ports/metadata-instance-validator.js";
import type { OwnerMembershipSnapshot } from "../ports/owner-membership-reader.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";

export interface CatalogAuthoritySnapshot {
  readonly metadata: MetadataSchemaSnapshot;
  readonly owners: OwnerMembershipSnapshot;
  readonly profile: CatalogProfileSnapshot;
  readonly sidecar?: DocumentMetadataSidecarSnapshot;
}

function sameEvidence(
  left: DocumentAuthorityEvidence,
  right: DocumentAuthorityEvidence
): boolean {
  return left.path === right.path && left.digest === right.digest && left.size === right.size;
}

export function assertCatalogAuthorityStable(
  before: CatalogAuthoritySnapshot,
  after: CatalogAuthoritySnapshot
): void {
  if (
    !sameEvidence(before.metadata.evidence, after.metadata.evidence) ||
    !sameEvidence(before.owners.evidence, after.owners.evidence) ||
    !sameEvidence(before.profile.evidence, after.profile.evidence) ||
    (before.sidecar === undefined) !== (after.sidecar === undefined) ||
    (before.sidecar !== undefined &&
      after.sidecar !== undefined &&
      !sameEvidence(before.sidecar.evidence, after.sidecar.evidence))
  ) {
    throw new DocumentCatalogError(
      "DOCUMENT_CATALOG_AUTHORITY_CHANGED",
      "Document catalog authority changed while the repository was observed."
    );
  }
}

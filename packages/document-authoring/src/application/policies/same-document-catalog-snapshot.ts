import type {
  DocumentAuthorityEvidence,
  DocumentationCatalogSnapshotContract
} from "../model/document-catalog.js";

function sameEvidence(left: DocumentAuthorityEvidence, right: DocumentAuthorityEvidence): boolean {
  return left.path === right.path && left.digest === right.digest && left.size === right.size;
}

function authority(
  catalog: DocumentationCatalogSnapshotContract
): readonly DocumentAuthorityEvidence[] {
  return [
    catalog.authority.profile,
    catalog.authority.metadataSchema,
    catalog.authority.ownerCatalog,
    ...(catalog.authority.metadataSidecar === undefined
      ? [] : [catalog.authority.metadataSidecar])
  ];
}

export function sameDocumentCatalogSnapshot(
  left: DocumentationCatalogSnapshotContract,
  right: DocumentationCatalogSnapshotContract
): boolean {
  const leftAuthority = authority(left);
  const rightAuthority = authority(right);
  return left.status === right.status && left.projectId === right.projectId &&
    leftAuthority.length === rightAuthority.length &&
    leftAuthority.every((entry, index) => sameEvidence(entry, rightAuthority[index]!)) &&
    JSON.stringify(left.diagnostics) === JSON.stringify(right.diagnostics) &&
    JSON.stringify(left.documents) === JSON.stringify(right.documents) &&
    JSON.stringify(left.identityProjection) === JSON.stringify(right.identityProjection) &&
    JSON.stringify(left.ownerIds) === JSON.stringify(right.ownerIds);
}

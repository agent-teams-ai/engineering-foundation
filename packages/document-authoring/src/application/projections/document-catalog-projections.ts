import { compareBinaryStrings } from "../../binary-string-comparator.js";
import type {
  DocumentationCatalogSnapshot,
  ReferencedDocumentProjectionResult
} from "../model/document-catalog.js";

export function projectReferencedDocuments(
  snapshot: DocumentationCatalogSnapshot,
  referencedIds: readonly string[]
): ReferencedDocumentProjectionResult {
  const byId = new Map(snapshot.documents.map((document) => [document.id, document]));
  const identityCountById = new Map<string, number>();
  for (const identity of snapshot.identityProjection) {
    identityCountById.set(
      identity.id,
      (identityCountById.get(identity.id) ?? 0) + 1
    );
  }
  const uniqueIds = [...new Set(referencedIds)].toSorted(compareBinaryStrings);
  const documents = uniqueIds.flatMap((id) => {
    const document = byId.get(id);
    return document === undefined || identityCountById.get(id) !== 1
      ? []
      : [{ id: document.id, path: document.repositoryPath }];
  });
  const missingIds = uniqueIds.filter((id) => !identityCountById.has(id));
  const resolvedIds = new Set(documents.map((document) => document.id));
  const unresolvedIds = uniqueIds.filter(
    (id) => identityCountById.has(id) && !resolvedIds.has(id)
  );
  return Object.freeze({
    documents: Object.freeze(documents.map((document) => Object.freeze(document))),
    missingIds: Object.freeze(missingIds),
    unresolvedIds: Object.freeze(unresolvedIds)
  });
}

import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import type {
  DocumentationCatalogSnapshot,
  ReferencedDocumentProjectionResult
} from "../model/document-catalog.js";

export function projectReferencedDocuments(
  snapshot: DocumentationCatalogSnapshot,
  referencedIds: readonly string[]
): ReferencedDocumentProjectionResult {
  const byId = new Map(snapshot.documents.map((document) => [document.id, document]));
  const uniqueIds = [...new Set(referencedIds)].toSorted(compareBinaryStrings);
  const documents = uniqueIds.flatMap((id) => {
    const document = byId.get(id);
    return document === undefined
      ? []
      : [{ id: document.id, path: document.repositoryPath }];
  });
  const missingIds = uniqueIds.filter((id) => !byId.has(id));
  return Object.freeze({
    documents: Object.freeze(documents.map((document) => Object.freeze(document))),
    missingIds: Object.freeze(missingIds)
  });
}

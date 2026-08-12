import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import type {
  DocumentSearchCorpusEntry,
  DocumentationSearchCatalogSnapshot
} from "../model/document-catalog.js";
import type {
  DocumentFindFilters,
  DocumentFindQuery,
  DocumentFindResult
} from "../model/document-find.js";
import type {
  DocumentationSearchCatalogReader
} from "../ports/documentation-search-catalog-reader.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";

const OPAQUE_ID = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;
const LOWER_ID = /^[a-z0-9][a-z0-9._/-]*$/u;
const MAXIMUM_TEXT_LENGTH = 1_000;

export interface FindDocumentsRequest {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly query?: DocumentFindQuery;
  readonly signal?: AbortSignal;
}

interface CompiledDocumentFindQuery {
  readonly filters: DocumentFindFilters;
  readonly normalizedText?: string;
}

function invalidQuery(message: string): never {
  throw new DocumentCatalogError(
    "DOCUMENT_CATALOG_INPUT_INVALID",
    `Document query is invalid: ${message}`
  );
}

function containsUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      return true;
    }
  }
  return false;
}

function validateFilter(
  value: string | undefined,
  name: string,
  maximumLength: number,
  pattern: RegExp
): void {
  if (value === undefined) {
    return;
  }
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    containsUnsafeCharacter(value) ||
    !pattern.test(value)
  ) {
    invalidQuery(`${name} does not use the bounded document identifier grammar.`);
  }
}

function compileDocumentFindQuery(
  query: DocumentFindQuery | undefined
): CompiledDocumentFindQuery {
  const filters = query?.filters ?? {};
  validateFilter(filters.id, "id", 214, OPAQUE_ID);
  validateFilter(filters.owner, "owner", 214, OPAQUE_ID);
  validateFilter(filters.status, "status", 160, LOWER_ID);
  validateFilter(filters.type, "type", 160, LOWER_ID);
  const text = query?.text;
  if (
    text !== undefined &&
    (text.length > MAXIMUM_TEXT_LENGTH || containsUnsafeCharacter(text))
  ) {
    invalidQuery("text must be a bounded Unicode string without control characters.");
  }
  return Object.freeze({
    filters: Object.freeze({ ...filters }),
    ...(text === undefined
      ? {}
      : { normalizedText: text.normalize("NFC").toLowerCase() })
  });
}

function matchesFilters(
  entry: DocumentSearchCorpusEntry,
  filters: DocumentFindFilters
): boolean {
  const { descriptor } = entry;
  return (
    (filters.id === undefined || descriptor.id === filters.id) &&
    (filters.owner === undefined || descriptor.owner === filters.owner) &&
    (filters.status === undefined || descriptor.status === filters.status) &&
    (filters.type === undefined || descriptor.type === filters.type)
  );
}

function normalizedSearchFields(entry: DocumentSearchCorpusEntry): readonly string[] {
  return [
    entry.descriptor.id,
    entry.descriptor.title,
    entry.descriptor.summary,
    ...entry.headings,
    entry.body
  ].map((value) => value.normalize("NFC").toLowerCase());
}

function findInSnapshot(
  snapshot: DocumentationSearchCatalogSnapshot,
  query: CompiledDocumentFindQuery
): DocumentFindResult {
  const documents = snapshot.documents
    .filter(
      (entry) =>
        matchesFilters(entry, query.filters) &&
        (query.normalizedText === undefined ||
          normalizedSearchFields(entry).some((field) =>
            field.includes(query.normalizedText ?? "")
          ))
    )
    .map((entry) => entry.descriptor)
    .toSorted(
      (left, right) =>
        compareBinaryStrings(left.id, right.id) ||
        compareBinaryStrings(left.repositoryPath, right.repositoryPath)
    );
  return Object.freeze({
    catalogStatus: snapshot.catalog.status,
    diagnostics: snapshot.catalog.diagnostics,
    documents: Object.freeze(documents),
    matches: documents.length
  });
}

export class FindDocuments {
  readonly #catalog: DocumentationSearchCatalogReader;

  constructor(catalog: DocumentationSearchCatalogReader) {
    this.#catalog = catalog;
  }

  async execute(request: FindDocumentsRequest): Promise<DocumentFindResult> {
    const query = compileDocumentFindQuery(request.query);
    const snapshot = await this.#catalog.read({
      consumerRoot: request.consumerRoot,
      profilePath: request.profilePath,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });
    return findInSnapshot(snapshot, query);
  }
}

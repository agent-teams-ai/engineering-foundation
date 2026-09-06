import type { DocsFindDocument } from "./model.js";

const MAXIMUM_DOCUMENTS = 10_000;
const MAXIMUM_FIELD_BYTES = 65_536;

const BINARY = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export class CommunityContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunityContextError";
  }
}

export interface CommunitySearchRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly repositoryPath: string;
  readonly owner: string;
  readonly type: string;
  readonly status: string;
  readonly related: string;
  readonly blockedBy: string;
}

export interface CommunitySearchHit {
  readonly id: string | number;
  readonly score: number;
}

/** The narrow subset of MiniSearch used by this projection. */
export interface CommunitySearchIndex {
  /** Atomically replaces the indexed corpus so one adapter can serve repeated projections. */
  replaceAll(documents: CommunitySearchRecord[]): void;
  search(query: string): readonly CommunitySearchHit[];
}

export interface CommunityRankedDocument {
  readonly document: DocsFindDocument;
  readonly score: number;
  readonly ranking: "binary-default" | "fuzzy-advisory";
}

export interface RankCommunityDocumentsInput {
  readonly documents: readonly DocsFindDocument[];
  readonly query: string;
  readonly searchIndex?: CommunitySearchIndex;
  readonly maxResults?: number;
}

function normalizedField(value: unknown, subject: string): string {
  if (typeof value !== "string") {
    throw new CommunityContextError(`${subject} must be a string.`);
  }
  const normalized = value.normalize("NFC");
  if (normalized.includes("\u0000") || Buffer.byteLength(normalized, "utf8") > MAXIMUM_FIELD_BYTES) {
    throw new CommunityContextError(`${subject} is outside the bounded text contract.`);
  }
  return normalized;
}

function normalizedStringArray(value: unknown, subject: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new CommunityContextError(`${subject} must be an array of strings.`);
  }
  return Object.freeze(value.map((entry, index) => normalizedField(entry, `${subject}[${String(index)}]`)));
}

function normalizeDocument(document: DocsFindDocument, index: number): DocsFindDocument {
  const subject = `documents[${String(index)}]`;
  return Object.freeze({
    id: normalizedField(document.id, `${subject}.id`),
    owner: normalizedField(document.owner, `${subject}.owner`),
    repositoryPath: normalizedField(document.repositoryPath, `${subject}.repositoryPath`),
    source: document.source,
    status: normalizedField(document.status, `${subject}.status`),
    summary: normalizedField(document.summary, `${subject}.summary`),
    title: normalizedField(document.title, `${subject}.title`),
    type: normalizedField(document.type, `${subject}.type`),
    // Metadata remains opaque consumer authority. Never spread or index its keys.
    metadata: document.metadata,
    related: normalizedStringArray(document.related, `${subject}.related`),
    blockedBy: normalizedStringArray(document.blockedBy, `${subject}.blockedBy`)
  });
}

function compareDocuments(left: DocsFindDocument, right: DocsFindDocument): number {
  const byId = BINARY(left.id, right.id);
  return byId === 0 ? BINARY(left.repositoryPath, right.repositoryPath) : byId;
}

function normalizedCorpus(documents: readonly DocsFindDocument[]): readonly DocsFindDocument[] {
  if (documents.length > MAXIMUM_DOCUMENTS) {
    throw new CommunityContextError(`Document corpus exceeds ${String(MAXIMUM_DOCUMENTS)} entries.`);
  }
  const normalized = documents.map(normalizeDocument).toSorted(compareDocuments);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const document of normalized) {
    if (ids.has(document.id)) {
      throw new CommunityContextError(`Duplicate canonical document id: ${document.id}.`);
    }
    if (paths.has(document.repositoryPath)) {
      throw new CommunityContextError(`Duplicate canonical document path: ${document.repositoryPath}.`);
    }
    ids.add(document.id);
    paths.add(document.repositoryPath);
  }
  return Object.freeze(normalized);
}

function maximumResults(value: number | undefined, corpusSize: number): number {
  if (value === undefined) {return corpusSize;}
  if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_DOCUMENTS) {
    throw new CommunityContextError(`maxResults must be an integer from 0 through ${String(MAXIMUM_DOCUMENTS)}.`);
  }
  return value;
}

function searchRecord(document: DocsFindDocument): CommunitySearchRecord {
  return Object.freeze({
    id: document.id,
    title: document.title,
    summary: document.summary,
    repositoryPath: document.repositoryPath,
    owner: document.owner,
    type: document.type,
    status: document.status,
    related: document.related.join("\n"),
    blockedBy: document.blockedBy.join("\n")
  });
}

export function rankCommunityDocuments(input: RankCommunityDocumentsInput): readonly CommunityRankedDocument[] {
  const documents = normalizedCorpus(input.documents);
  const limit = maximumResults(input.maxResults, documents.length);
  if (documents.length === 0 || limit === 0) {return Object.freeze([]);}

  const query = normalizedField(input.query, "query").trim();
  if (query.length === 0) {
    return Object.freeze(documents.slice(0, limit).map((document) =>
      Object.freeze({ document, score: 0, ranking: "binary-default" as const })));
  }
  if (input.searchIndex === undefined) {
    throw new CommunityContextError("A searchIndex is required for a non-empty fuzzy query.");
  }

  input.searchIndex.replaceAll(documents.map(searchRecord));
  const byId = new Map(documents.map((document) => [document.id, document] as const));
  const seenHits = new Set<string>();
  const ranked = input.searchIndex.search(query).map((hit, index) => {
    if (typeof hit.id !== "string" || !Number.isFinite(hit.score) || hit.score < 0) {
      throw new CommunityContextError(`Search hit ${String(index)} is malformed.`);
    }
    const id = hit.id.normalize("NFC");
    const document = byId.get(id);
    if (document === undefined || seenHits.has(id)) {
      throw new CommunityContextError(`Search hit ${String(index)} has an unknown or duplicate id.`);
    }
    seenHits.add(id);
    return Object.freeze({ document, score: hit.score, ranking: "fuzzy-advisory" as const });
  });

  return Object.freeze(ranked.toSorted((left, right) =>
    right.score - left.score || compareDocuments(left.document, right.document)).slice(0, limit));
}

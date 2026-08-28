import MiniSearch from "minisearch";

import {
  CommunityContextError,
  type CommunitySearchHit,
  type CommunitySearchIndex,
  type CommunitySearchRecord
} from "./ranked-search.js";

function stringSearchHitId(value: unknown): string {
  if (typeof value !== "string") {
    throw new CommunityContextError("MiniSearch returned a non-string document id.");
  }
  return value;
}

const SEARCH_FIELDS = [
  "title",
  "summary",
  "id",
  "repositoryPath",
  "owner",
  "type",
  "status",
  "related",
  "blockedBy"
] as const;

function createIndex(): MiniSearch<CommunitySearchRecord> {
  return new MiniSearch<CommunitySearchRecord>({
    fields: [...SEARCH_FIELDS],
    idField: "id",
    searchOptions: {
      boost: { id: 4, title: 3, summary: 2, repositoryPath: 1.5 },
      combineWith: "AND",
      fuzzy: 0.2,
      prefix: true
    }
  });
}

export class CommunityMiniSearchIndex implements CommunitySearchIndex {
  #index = createIndex();

  replaceAll(documents: CommunitySearchRecord[]): void {
    const replacement = createIndex();
    try {
      replacement.addAll(documents);
    } catch {
      throw new CommunityContextError("Search index rejected the canonical document corpus.");
    }
    this.#index = replacement;
  }

  search(query: string): readonly CommunitySearchHit[] {
    try {
      return Object.freeze(this.#index.search(query).map(({ id, score }) =>
        Object.freeze({ id: stringSearchHitId(id), score })));
    } catch (error) {
      if (error instanceof CommunityContextError) {throw error;}
      throw new CommunityContextError("Search index could not evaluate the canonical query.");
    }
  }
}

export function createCommunityMiniSearchIndex(): CommunitySearchIndex {
  return new CommunityMiniSearchIndex();
}

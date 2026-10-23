import assert from "node:assert/strict";
import test from "node:test";
import type { DocsFindDocument } from "../../dist/features/portable-documentation/application/model.js";
import type {
  CommunitySearchRecord,
  CommunitySearchHit,
} from "../../dist/features/portable-documentation/application/ranked-search.js";
import {
  CommunityContextError,
  rankCommunityDocuments,
} from "../../dist/features/portable-documentation/application/ranked-search.js";
import { projectCommunityLlmsText } from "../../dist/features/portable-documentation/application/llms-text.js";
import { createCommunityMiniSearchIndex } from "../../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";

export function document(overrides: Partial<DocsFindDocument> = {}): DocsFindDocument {
  return {
    id: "ADR-0001",
    owner: "architecture/tooling",
    repositoryPath: "docs/decisions/0001-first.md",
    source: "markdown-tree",
    status: "accepted",
    summary: "First decision",
    title: "First",
    type: "adr",
    metadata: {},
    related: [],
    blockedBy: [],
    ...overrides,
  };
}

export class SearchIndexFixture {
  records: CommunitySearchRecord[] = [];
  query: string | undefined;
  readonly hits: readonly CommunitySearchHit[];
  constructor(hits: readonly CommunitySearchHit[]) {
    this.hits = hits;
  }
  replaceAll(records: CommunitySearchRecord[]): void {
    this.records = [...records];
  }
  search(query: string): readonly CommunitySearchHit[] {
    this.query = query;
    return this.hits;
  }
}

void test("ranked search is stable by score then canonical binary id/path", () => {
  const documents = [
    document({ id: "ADR-0002", title: "Second", repositoryPath: "docs/decisions/0002.md" }),
    document({ id: "ADR-0001", title: "Cafe\u0301", repositoryPath: "docs/decisions/0001.md" }),
    document({ id: "ADR-0003", title: "Third", repositoryPath: "docs/decisions/0003.md" }),
  ];
  const index = new SearchIndexFixture([
    { id: "ADR-0003", score: 4 },
    { id: "ADR-0002", score: 7 },
    { id: "ADR-0001", score: 7 },
  ]);
  const ranked = rankCommunityDocuments({ documents, query: "cafe\u0301", searchIndex: index });

  assert.equal(index.query, "café");
  assert.deepEqual(
    ranked.map(({ document: entry }) => entry.id),
    ["ADR-0001", "ADR-0002", "ADR-0003"],
  );
  assert.deepEqual(
    ranked.map(({ ranking }) => ranking),
    ["fuzzy-advisory", "fuzzy-advisory", "fuzzy-advisory"],
  );
  assert.equal(index.records.find(({ id }) => id === "ADR-0001")?.title, "Café");
  const firstRecord = index.records[0];
  assert.ok(firstRecord);
  assert.equal(Object.hasOwn(firstRecord, "metadata"), false);
});

void test("empty query and empty corpus do not require or invoke a search index", () => {
  const index = {
    replaceAll() {
      throw new Error("not expected");
    },
    search() {
      throw new Error("not expected");
    },
  };
  const documents = [
    document({ id: "ADR-0002", repositoryPath: "docs/2.md" }),
    document({ id: "ADR-0001", repositoryPath: "docs/1.md" }),
  ];
  assert.deepEqual(
    rankCommunityDocuments({ documents, query: "  ", searchIndex: index }).map(
      ({ document: entry }) => entry.id,
    ),
    ["ADR-0001", "ADR-0002"],
  );
  assert.deepEqual(
    rankCommunityDocuments({ documents: [], query: "anything", searchIndex: index }),
    [],
  );
});

void test("MiniSearch adapter replaces its corpus across repeated ranked queries", () => {
  const documents = [
    document({ id: "ADR-0001", title: "First decision", repositoryPath: "docs/1.md" }),
    document({ id: "ADR-0002", title: "Second decision", repositoryPath: "docs/2.md" }),
  ];
  const index = createCommunityMiniSearchIndex();
  const first = rankCommunityDocuments({ documents, query: "first", searchIndex: index });
  const second = rankCommunityDocuments({ documents, query: "second", searchIndex: index });

  assert.equal(first[0]?.document.id, "ADR-0001");
  assert.equal(second[0]?.document.id, "ADR-0002");
});

void test("ranked search fails closed on canonical duplicates and malformed adapter hits", () => {
  assert.throws(
    () =>
      rankCommunityDocuments({
        documents: [
          document({ id: "CAFÉ", repositoryPath: "docs/a.md" }),
          document({ id: "CAFE\u0301", repositoryPath: "docs/b.md" }),
        ],
        query: "",
      }),
    /Duplicate canonical document id/u,
  );
  assert.throws(
    () =>
      rankCommunityDocuments({
        documents: [
          document({ id: "A", repositoryPath: "docs/café.md" }),
          document({ id: "B", repositoryPath: "docs/cafe\u0301.md" }),
        ],
        query: "",
      }),
    /Duplicate canonical document path/u,
  );
  assert.throws(
    () =>
      rankCommunityDocuments({
        documents: [document()],
        query: "decision",
        searchIndex: new SearchIndexFixture([{ id: "missing", score: 1 }]),
      }),
    /unknown or duplicate id/u,
  );
  assert.throws(
    () =>
      rankCommunityDocuments({
        documents: [document()],
        query: "decision",
        searchIndex: new SearchIndexFixture([{ id: "ADR-0001", score: Number.NaN }]),
      }),
    /malformed/u,
  );
});

void test("search projection ignores hostile metadata and prototype keys", () => {
  let accessed = false;
  const metadata: Record<string, never> = {};
  Object.setPrototypeOf(metadata, { inherited: "/Users/example/private" });
  Object.defineProperty(metadata, "__proto__", { enumerable: true, value: { polluted: true } });
  Object.defineProperty(metadata, "generatedAt", {
    enumerable: true,
    get() {
      accessed = true;
      return "2026-01-01T00:00:00Z";
    },
  });
  const index = new SearchIndexFixture([{ id: "ADR-0001", score: 1 }]);
  const [ranked] = rankCommunityDocuments({
    documents: [document({ metadata })],
    query: "first",
    searchIndex: index,
  });
  assert.equal(accessed, false);
  assert.ok(ranked);
  assert.equal(ranked.document.metadata, metadata);
  const firstRecord = index.records[0];
  assert.ok(firstRecord);
  assert.equal(Object.hasOwn(firstRecord, "__proto__"), false);
  assert.equal(Object.hasOwn(firstRecord, "generatedAt"), false);
});

void test("filtered llms.txt projection is permutation-stable, NFC, relative, and has one final newline", () => {
  const documents = [
    document({
      id: "ADR-0002",
      title: "Second",
      repositoryPath: "docs/with space/second.md",
      summary: "Next",
    }),
    document({
      id: "ADR-0001",
      title: "Cafe\u0301",
      repositoryPath: "docs/first.md",
      metadata: { absolutePath: "/Users/example/private", generatedAt: "2026-01-01T00:00:00Z" },
    }),
  ];
  const input = {
    catalog: { projectId: "community", title: "Cafe\u0301 docs", summary: "Public catalog" },
    documents,
    selection: { kind: "filtered" as const },
  };
  const first = projectCommunityLlmsText(input);
  const second = projectCommunityLlmsText({ ...input, documents: documents.toReversed() });

  assert.equal(first.content, second.content);
  assert.deepEqual(first.limits, { maxBytes: 262144, maxDocuments: 64 });
  assert.equal(first.content, first.content.normalize("NFC"));
  assert.equal(first.content.includes("Fuzzy search"), false);
  assert.match(first.content, /\(\.\/docs\/with%20space\/second\.md\)/u);
  assert.equal(first.content.includes("/Users/example"), false);
  assert.equal(first.content.includes("generatedAt"), false);
  assert.equal(first.content.endsWith("\n"), true);
  assert.equal(first.content.endsWith("\n\n"), false);
});

void test("fuzzy llms.txt projection preserves deterministic relevance order", () => {
  const projection = projectCommunityLlmsText({
    catalog: { projectId: "community", title: "Community docs" },
    documents: [
      document({ id: "ADR-0002", repositoryPath: "docs/2.md" }),
      document({ id: "ADR-0001", repositoryPath: "docs/1.md" }),
    ],
    selection: { kind: "fuzzy-advisory" },
  });
  assert.ok(projection.content.indexOf("ADR-0002") < projection.content.indexOf("ADR-0001"));
});

void test("llms.txt projection enforces document and byte budgets with explicit truncation", () => {
  const documents = Array.from({ length: 8 }, (_, index) =>
    document({
      id: `ADR-${String(index).padStart(4, "0")}`,
      repositoryPath: `docs/${String(index)}.md`,
      summary: "A bounded summary ".repeat(4),
    }),
  );
  const projection = projectCommunityLlmsText({
    catalog: { projectId: "community", title: "Community docs" },
    documents,
    limits: { maxDocuments: 3, maxBytes: 1024 },
  });
  assert.equal(projection.includedDocuments, 3);
  assert.equal(projection.omittedDocuments, 5);
  assert.equal(projection.truncated, true);
  assert.deepEqual(projection.limits, { maxBytes: 1024, maxDocuments: 3 });
  assert.match(projection.content, /## Truncation/u);
  assert.ok(Buffer.byteLength(projection.content, "utf8") <= 1024);

  assert.throws(
    () =>
      projectCommunityLlmsText({
        catalog: { projectId: "community", title: "Community docs" },
        documents,
        limits: { maxBytes: 1_048_577 },
      }),
    CommunityContextError,
  );
  assert.throws(
    () =>
      projectCommunityLlmsText({
        catalog: { projectId: "community", title: "Community docs" },
        documents,
        limits: { maxDocuments: 10_001 },
      }),
    CommunityContextError,
  );
});

void test("declared minimum context budget fits the maximum project header and fuzzy query", () => {
  const projectId = "a".repeat(160);
  const query = "private-query-".repeat(77).slice(0, 1000);
  const selection = { kind: "fuzzy-advisory" as const, query };
  const projection = projectCommunityLlmsText({
    catalog: {
      projectId,
      title: `${projectId} documentation`,
      summary: "Deterministic repository documentation context for humans and agents.",
    },
    documents: [document()],
    limits: { maxBytes: 1024, maxDocuments: 64 },
    selection,
  });

  assert.deepEqual(projection.limits, { maxBytes: 1024, maxDocuments: 64 });
  assert.ok(Buffer.byteLength(projection.content, "utf8") <= 1024);
  assert.equal(projection.content.includes(query), false);
  assert.match(projection.content, /Fuzzy advisory ranking was used/u);
  assert.throws(
    () =>
      projectCommunityLlmsText({
        catalog: { projectId, title: `${projectId} documentation` },
        documents: [],
        limits: { maxBytes: 1023 },
      }),
    /maxBytes must be at least 1024/u,
  );
});

void test("llms.txt projection rejects absolute and parent-traversing document links", () => {
  for (const repositoryPath of [
    "/tmp/private.md",
    "../private.md",
    "docs/../private.md",
    "C:/private.md",
    "https://example.test/private.md",
  ]) {
    assert.throws(
      () =>
        projectCommunityLlmsText({
          catalog: { projectId: "community", title: "Community docs" },
          documents: [document({ repositoryPath })],
        }),
      /repository-relative path/u,
    );
  }
});

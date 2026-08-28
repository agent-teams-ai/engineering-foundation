import assert from "node:assert/strict";
import test from "node:test";

import {
  CommunityContextError,
  rankCommunityDocuments
} from "../dist/community/context/ranked-search.js";
import { projectCommunityLlmsText } from "../dist/community/context/llms-text.js";
import { createCommunityMiniSearchIndex } from "../dist/community/context/minisearch-adapter.js";
import {
  projectCommunityContext,
  projectCommunityFind
} from "../dist/community/context/community-query.js";

function document(overrides = {}) {
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
    ...overrides
  };
}

class SearchIndexFixture {
  records = [];
  constructor(hits) {this.hits = hits;}
  replaceAll(records) {this.records = [...records];}
  search(query) {this.query = query; return this.hits;}
}

test("ranked search is stable by score then canonical binary id/path", () => {
  const documents = [
    document({ id: "ADR-0002", title: "Second", repositoryPath: "docs/decisions/0002.md" }),
    document({ id: "ADR-0001", title: "Cafe\u0301", repositoryPath: "docs/decisions/0001.md" }),
    document({ id: "ADR-0003", title: "Third", repositoryPath: "docs/decisions/0003.md" })
  ];
  const index = new SearchIndexFixture([
    { id: "ADR-0003", score: 4 },
    { id: "ADR-0002", score: 7 },
    { id: "ADR-0001", score: 7 }
  ]);
  const ranked = rankCommunityDocuments({ documents, query: "cafe\u0301", searchIndex: index });

  assert.equal(index.query, "café");
  assert.deepEqual(ranked.map(({ document: entry }) => entry.id), ["ADR-0001", "ADR-0002", "ADR-0003"]);
  assert.deepEqual(ranked.map(({ ranking }) => ranking), ["fuzzy-advisory", "fuzzy-advisory", "fuzzy-advisory"]);
  assert.equal(index.records.find(({ id }) => id === "ADR-0001").title, "Café");
  assert.equal(Object.hasOwn(index.records[0], "metadata"), false);
});

test("empty query and empty corpus do not require or invoke a search index", () => {
  const index = { replaceAll() {throw new Error("not expected");}, search() {throw new Error("not expected");} };
  const documents = [
    document({ id: "ADR-0002", repositoryPath: "docs/2.md" }),
    document({ id: "ADR-0001", repositoryPath: "docs/1.md" })
  ];
  assert.deepEqual(
    rankCommunityDocuments({ documents, query: "  ", searchIndex: index }).map(({ document: entry }) => entry.id),
    ["ADR-0001", "ADR-0002"]
  );
  assert.deepEqual(rankCommunityDocuments({ documents: [], query: "anything", searchIndex: index }), []);
});

test("MiniSearch adapter replaces its corpus across repeated ranked queries", () => {
  const documents = [
    document({ id: "ADR-0001", title: "First decision", repositoryPath: "docs/1.md" }),
    document({ id: "ADR-0002", title: "Second decision", repositoryPath: "docs/2.md" })
  ];
  const index = createCommunityMiniSearchIndex();
  const first = rankCommunityDocuments({ documents, query: "first", searchIndex: index });
  const second = rankCommunityDocuments({ documents, query: "second", searchIndex: index });

  assert.equal(first[0]?.document.id, "ADR-0001");
  assert.equal(second[0]?.document.id, "ADR-0002");
});

test("ranked search fails closed on canonical duplicates and malformed adapter hits", () => {
  assert.throws(() => rankCommunityDocuments({
    documents: [
      document({ id: "CAFÉ", repositoryPath: "docs/a.md" }),
      document({ id: "CAFE\u0301", repositoryPath: "docs/b.md" })
    ],
    query: ""
  }), /Duplicate canonical document id/u);
  assert.throws(() => rankCommunityDocuments({
    documents: [
      document({ id: "A", repositoryPath: "docs/café.md" }),
      document({ id: "B", repositoryPath: "docs/cafe\u0301.md" })
    ],
    query: ""
  }), /Duplicate canonical document path/u);
  assert.throws(() => rankCommunityDocuments({
    documents: [document()],
    query: "decision",
    searchIndex: new SearchIndexFixture([{ id: "missing", score: 1 }])
  }), /unknown or duplicate id/u);
  assert.throws(() => rankCommunityDocuments({
    documents: [document()],
    query: "decision",
    searchIndex: new SearchIndexFixture([{ id: "ADR-0001", score: Number.NaN }])
  }), /malformed/u);
});

test("search projection ignores hostile metadata and prototype keys", () => {
  let accessed = false;
  const metadata = Object.create({ inherited: "/Users/example/private" });
  Object.defineProperty(metadata, "__proto__", { enumerable: true, value: { polluted: true } });
  Object.defineProperty(metadata, "generatedAt", { enumerable: true, get() {accessed = true; return "2026-01-01T00:00:00Z";} });
  const index = new SearchIndexFixture([{ id: "ADR-0001", score: 1 }]);
  const [ranked] = rankCommunityDocuments({ documents: [document({ metadata })], query: "first", searchIndex: index });
  assert.equal(accessed, false);
  assert.equal(ranked.document.metadata, metadata);
  assert.equal(Object.hasOwn(index.records[0], "__proto__"), false);
  assert.equal(Object.hasOwn(index.records[0], "generatedAt"), false);
});

test("filtered llms.txt projection is permutation-stable, NFC, relative, and has one final newline", () => {
  const documents = [
    document({ id: "ADR-0002", title: "Second", repositoryPath: "docs/with space/second.md", summary: "Next" }),
    document({ id: "ADR-0001", title: "Cafe\u0301", repositoryPath: "docs/first.md", metadata: { absolutePath: "/Users/example/private", generatedAt: "2026-01-01T00:00:00Z" } })
  ];
  const input = {
    catalog: { projectId: "community", title: "Cafe\u0301 docs", summary: "Public catalog" },
    documents,
    selection: { kind: "filtered" }
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

test("fuzzy llms.txt projection preserves deterministic relevance order", () => {
  const projection = projectCommunityLlmsText({
    catalog: { projectId: "community", title: "Community docs" },
    documents: [
      document({ id: "ADR-0002", repositoryPath: "docs/2.md" }),
      document({ id: "ADR-0001", repositoryPath: "docs/1.md" })
    ],
    selection: { kind: "fuzzy-advisory" }
  });
  assert.ok(projection.content.indexOf("ADR-0002") < projection.content.indexOf("ADR-0001"));
});

test("llms.txt projection enforces document and byte budgets with explicit truncation", () => {
  const documents = Array.from({ length: 8 }, (_, index) => document({
    id: `ADR-${String(index).padStart(4, "0")}`,
    repositoryPath: `docs/${String(index)}.md`,
    summary: "A bounded summary ".repeat(4)
  }));
  const projection = projectCommunityLlmsText({
    catalog: { projectId: "community", title: "Community docs" },
    documents,
    limits: { maxDocuments: 3, maxBytes: 1024 }
  });
  assert.equal(projection.includedDocuments, 3);
  assert.equal(projection.omittedDocuments, 5);
  assert.equal(projection.truncated, true);
  assert.deepEqual(projection.limits, { maxBytes: 1024, maxDocuments: 3 });
  assert.match(projection.content, /## Truncation/u);
  assert.ok(Buffer.byteLength(projection.content, "utf8") <= 1024);

  assert.throws(() => projectCommunityLlmsText({
    catalog: { projectId: "community", title: "Community docs" }, documents, limits: { maxBytes: 1_048_577 }
  }), CommunityContextError);
  assert.throws(() => projectCommunityLlmsText({
    catalog: { projectId: "community", title: "Community docs" }, documents, limits: { maxDocuments: 10_001 }
  }), CommunityContextError);
});

test("declared minimum context budget fits the maximum project header and fuzzy query", () => {
  const projectId = "a".repeat(160);
  const query = "private-query-".repeat(77).slice(0, 1000);
  const projection = projectCommunityLlmsText({
    catalog: {
      projectId,
      title: `${projectId} documentation`,
      summary: "Deterministic repository documentation context for humans and agents."
    },
    documents: [document()],
    limits: { maxBytes: 1024, maxDocuments: 64 },
    selection: { kind: "fuzzy-advisory", query }
  });

  assert.deepEqual(projection.limits, { maxBytes: 1024, maxDocuments: 64 });
  assert.ok(Buffer.byteLength(projection.content, "utf8") <= 1024);
  assert.equal(projection.content.includes(query), false);
  assert.match(projection.content, /Fuzzy advisory ranking was used/u);
  assert.throws(() => projectCommunityLlmsText({
    catalog: { projectId, title: `${projectId} documentation` },
    documents: [],
    limits: { maxBytes: 1023 }
  }), /maxBytes must be at least 1024/u);
});

test("llms.txt projection rejects absolute and parent-traversing document links", () => {
  for (const repositoryPath of ["/tmp/private.md", "../private.md", "docs/../private.md", "C:/private.md", "https://example.test/private.md"]) {
    assert.throws(() => projectCommunityLlmsText({
      catalog: { projectId: "community", title: "Community docs" },
      documents: [document({ repositoryPath })]
    }), /repository-relative path/u);
  }
});

function catalog(overrides = {}) {
  return {
    projectId: "community",
    status: "complete",
    diagnostics: [],
    documents: [document()],
    identityProjection: [],
    ownerIds: ["architecture/tooling"],
    authority: {},
    semanticDigest: `sha256:${"1".repeat(64)}`,
    ...overrides
  };
}

test("fuzzy find withholds partial Foundation results and preserves diagnostics", async () => {
  const projection = await projectCommunityFind({
    consumerRoot: "/fixture",
    foundationProfilePath: "docs.config.yaml",
    query: { text: "first", ranking: "fuzzy-advisory" },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "partial",
          catalogSemanticDigest: `sha256:${"1".repeat(64)}`,
          diagnostics: [{
            ruleId: "document.catalog.invalid",
            severity: "error",
            subject: "docs/broken.md",
            message: "Document metadata is invalid."
          }],
          documents: [document()]
        };
      }
    }
  });
  assert.equal(projection.outcome, "violation");
  assert.equal(projection.result.matches, 0);
  assert.deepEqual(projection.result.documents, []);
  assert.equal(projection.diagnostics[0].ruleId, "document.catalog.invalid");
});

test("context canonicalizes and validates binary selection text before binding", async () => {
  const stable = catalog();
  let observedQuery;
  const foundation = {
    async findWithEvidence(input) {
      observedQuery = input.query;
      return {
        catalogStatus: "complete",
        catalogSemanticDigest: stable.semanticDigest,
        diagnostics: [],
        documents: stable.documents
      };
    },
    async buildCatalog() {return stable;}
  };
  const projection = await projectCommunityContext({
    catalogBefore: stable,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: { text: "  CAFE\u0301  " } },
    foundation
  });
  assert.equal(projection.outcome, "success");
  assert.deepEqual(projection.result.selection, {
    ranking: "binary-default",
    query: { text: "café" }
  });
  assert.equal(observedQuery.text, "café");

  for (const text of ["x".repeat(1_001), "unsafe\u0000query", "lone-\ud800-surrogate"]) {
    let authorityRead = false;
    await assert.rejects(() => projectCommunityContext({
      catalogBefore: stable,
      foundationProfilePath: "docs.config.yaml",
      request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: { text } },
      foundation: {
        async findWithEvidence() {authorityRead = true; throw new Error("must not read authority");},
        async buildCatalog() {authorityRead = true; throw new Error("must not read authority");}
      }
    }), /Search text/u);
    assert.equal(authorityRead, false);
  }
  for (const query of [
    { id: "bad:id" },
    { owner: "bad:id" },
    { type: "Tutorial" },
    { status: "In-Review" }
  ]) {
    let authorityRead = false;
    await assert.rejects(() => projectCommunityContext({
      catalogBefore: stable,
      foundationProfilePath: "docs.config.yaml",
      request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query },
      foundation: {
        async findWithEvidence() {authorityRead = true; throw new Error("must not read authority");},
        async buildCatalog() {authorityRead = true; throw new Error("must not read authority");}
      }
    }), /(?:canonical document ID|bounded lowercase identifier)/u);
    assert.equal(authorityRead, false);
  }
});

test("context rejects partial catalogs and ABA semantic digest changes", async () => {
  const stable = catalog();
  const partial = catalog({ status: "partial", diagnostics: [{
    ruleId: "document.catalog.invalid",
    severity: "error",
    subject: "docs/broken.md",
    message: "Document metadata is invalid."
  }] });
  const partialProjection = await projectCommunityContext({
    catalogBefore: partial,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: {} },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "partial",
          catalogSemanticDigest: partial.semanticDigest,
          diagnostics: partial.diagnostics,
          documents: partial.documents
        };
      },
      async buildCatalog() {return partial;}
    }
  });
  assert.equal(partialProjection.outcome, "violation");
  assert.deepEqual(partialProjection.result.selection, { ranking: "binary-default", query: {} });
  assert.deepEqual(partialProjection.result.limits, { maxBytes: 262144, maxDocuments: 64 });
  assert.equal(partialProjection.result.truncated, true);
  assert.equal(partialProjection.result.content, "");

  const middleDigest = `sha256:${"2".repeat(64)}`;
  const abaProjection = await projectCommunityContext({
    catalogBefore: stable,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: {} },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "complete",
          catalogSemanticDigest: middleDigest,
          diagnostics: [],
          documents: [document({ id: "ADR-0002", repositoryPath: "docs/2.md" })]
        };
      },
      async buildCatalog() {return stable;}
    }
  });
  assert.equal(abaProjection.outcome, "authority-stale");
  assert.equal(abaProjection.result.includedDocuments, 0);
  assert.equal(abaProjection.result.truncated, true);
  assert.deepEqual(abaProjection.result.selection, { ranking: "binary-default", query: {} });
});

test("zero-document partial context is withheld without claiming truncation", async () => {
  const partial = catalog({
    status: "partial",
    documents: [],
    diagnostics: [{
      ruleId: "document.catalog.invalid",
      severity: "error",
      subject: "docs/broken.md",
      message: "Document metadata is invalid."
    }]
  });
  const projection = await projectCommunityContext({
    catalogBefore: partial,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: {} },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "partial",
          catalogSemanticDigest: partial.semanticDigest,
          diagnostics: partial.diagnostics,
          documents: []
        };
      },
      async buildCatalog() {return partial;}
    }
  });

  assert.equal(projection.outcome, "violation");
  assert.equal(projection.result.includedDocuments, 0);
  assert.equal(projection.result.omittedDocuments, 0);
  assert.equal(projection.result.truncated, false);
  assert.equal(projection.result.content, "");
  assert.deepEqual(projection.result.limits, { maxBytes: 262144, maxDocuments: 64 });
});

test("zero-document ABA context is authority-stale without claiming truncation", async () => {
  const stable = catalog({ documents: [] });
  const middleDigest = `sha256:${"2".repeat(64)}`;
  const projection = await projectCommunityContext({
    catalogBefore: stable,
    foundationProfilePath: "docs.config.yaml",
    request: {
      consumerRoot: "/fixture",
      profilePath: "docs.config.yaml",
      query: { text: " cafe\u0301 ", owner: "platform", ranking: "fuzzy-advisory" },
      limits: { maxBytes: 4096, maxDocuments: 2 }
    },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "complete",
          catalogSemanticDigest: middleDigest,
          diagnostics: [],
          documents: []
        };
      },
      async buildCatalog() {return stable;}
    }
  });

  assert.equal(projection.outcome, "authority-stale");
  assert.equal(projection.result.includedDocuments, 0);
  assert.equal(projection.result.omittedDocuments, 0);
  assert.equal(projection.result.truncated, false);
  assert.equal(projection.result.content, "");
  assert.deepEqual(projection.result.selection, {
    ranking: "fuzzy-advisory",
    query: { text: "café", owner: "platform" }
  });
  assert.deepEqual(projection.result.limits, { maxBytes: 4096, maxDocuments: 2 });
  assert.equal(Object.hasOwn(projection.result, "ranking"), false);
});

test("partial context deduplicates repeated snapshot diagnostics and preserves distinct evidence", async () => {
  const repeated = {
    ruleId: "document.catalog.invalid",
    severity: "error",
    subject: "docs/broken.md",
    message: "Document metadata is invalid."
  };
  const distinct = { ...repeated, subject: "docs/other.md" };
  const overflow = Array.from({ length: 300 }, (_, index) => ({
    ...repeated,
    subject: `docs/overflow-${String(index).padStart(3, "0")}.md`
  }));
  const before = catalog({ status: "partial", diagnostics: [repeated] });
  const after = catalog({ status: "partial", diagnostics: [repeated, distinct, ...overflow] });
  const projection = await projectCommunityContext({
    catalogBefore: before,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: {} },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "partial",
          catalogSemanticDigest: before.semanticDigest,
          diagnostics: [repeated, distinct, ...overflow],
          documents: []
        };
      },
      async buildCatalog() {return after;}
    }
  });

  assert.equal(projection.outcome, "violation");
  assert.equal(projection.diagnostics.length, 256);
  assert.deepEqual(projection.diagnostics.slice(0, 2).map(({ subject }) => subject), ["docs/broken.md", "docs/other.md"]);
  assert.deepEqual(projection.diagnostics.at(-1), {
    ruleId: "docs.context.diagnostics-truncated",
    severity: "warning",
    phase: "authority",
    subject: "diagnostics",
    message: "Omitted 47 additional unique diagnostics after the deterministic 255-item context evidence limit."
  });
});

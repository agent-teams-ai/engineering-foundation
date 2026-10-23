import { document } from "./support/community-projection-cases.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { createCommunityMiniSearchIndex } from "../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";
import {
  projectCommunityContext,
  projectCommunityFind,
} from "../dist/features/portable-documentation/application/community-query.js";

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
    ...overrides,
  };
}

test("fuzzy find withholds partial Foundation results and preserves diagnostics", async () => {
  const projection = await projectCommunityFind({
    searchIndex: createCommunityMiniSearchIndex(),
    consumerRoot: "/fixture",
    foundationProfilePath: "docs.config.yaml",
    query: { text: "first", ranking: "fuzzy-advisory" },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "partial",
          catalogSemanticDigest: `sha256:${"1".repeat(64)}`,
          diagnostics: [
            {
              ruleId: "document.catalog.invalid",
              severity: "error",
              subject: "docs/broken.md",
              message: "Document metadata is invalid.",
            },
          ],
          documents: [document()],
        };
      },
    },
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
        documents: stable.documents,
      };
    },
    async buildCatalog() {
      return stable;
    },
  };
  const projection = await projectCommunityContext({
    searchIndex: createCommunityMiniSearchIndex(),
    catalogBefore: stable,
    foundationProfilePath: "docs.config.yaml",
    request: {
      consumerRoot: "/fixture",
      profilePath: "docs.config.yaml",
      query: { text: "  CAFE\u0301  " },
    },
    foundation,
  });
  assert.equal(projection.outcome, "success");
  assert.deepEqual(projection.result.selection, {
    ranking: "binary-default",
    query: { text: "café" },
  });
  assert.equal(observedQuery.text, "café");

  for (const text of ["x".repeat(1_001), "unsafe\u0000query", "lone-\ud800-surrogate"]) {
    let authorityRead = false;
    await assert.rejects(
      () =>
        projectCommunityContext({
          searchIndex: createCommunityMiniSearchIndex(),
          catalogBefore: stable,
          foundationProfilePath: "docs.config.yaml",
          request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: { text } },
          foundation: {
            async findWithEvidence() {
              authorityRead = true;
              throw new Error("must not read authority");
            },
            async buildCatalog() {
              authorityRead = true;
              throw new Error("must not read authority");
            },
          },
        }),
      /Search text/u,
    );
    assert.equal(authorityRead, false);
  }
  for (const query of [
    { id: "bad:id" },
    { owner: "bad:id" },
    { type: "Tutorial" },
    { status: "In-Review" },
  ]) {
    let authorityRead = false;
    await assert.rejects(
      () =>
        projectCommunityContext({
          searchIndex: createCommunityMiniSearchIndex(),
          catalogBefore: stable,
          foundationProfilePath: "docs.config.yaml",
          request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query },
          foundation: {
            async findWithEvidence() {
              authorityRead = true;
              throw new Error("must not read authority");
            },
            async buildCatalog() {
              authorityRead = true;
              throw new Error("must not read authority");
            },
          },
        }),
      /(?:canonical document ID|bounded lowercase identifier)/u,
    );
    assert.equal(authorityRead, false);
  }
});

test("context rejects partial catalogs and ABA semantic digest changes", async () => {
  const stable = catalog();
  const partial = catalog({
    status: "partial",
    diagnostics: [
      {
        ruleId: "document.catalog.invalid",
        severity: "error",
        subject: "docs/broken.md",
        message: "Document metadata is invalid.",
      },
    ],
  });
  const partialProjection = await projectCommunityContext({
    searchIndex: createCommunityMiniSearchIndex(),
    catalogBefore: partial,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: {} },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "partial",
          catalogSemanticDigest: partial.semanticDigest,
          diagnostics: partial.diagnostics,
          documents: partial.documents,
        };
      },
      async buildCatalog() {
        return partial;
      },
    },
  });
  assert.equal(partialProjection.outcome, "violation");
  assert.deepEqual(partialProjection.result.selection, { ranking: "binary-default", query: {} });
  assert.deepEqual(partialProjection.result.limits, { maxBytes: 262144, maxDocuments: 64 });
  assert.equal(partialProjection.result.truncated, true);
  assert.equal(partialProjection.result.content, "");

  const middleDigest = `sha256:${"2".repeat(64)}`;
  const abaProjection = await projectCommunityContext({
    searchIndex: createCommunityMiniSearchIndex(),
    catalogBefore: stable,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: {} },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "complete",
          catalogSemanticDigest: middleDigest,
          diagnostics: [],
          documents: [document({ id: "ADR-0002", repositoryPath: "docs/2.md" })],
        };
      },
      async buildCatalog() {
        return stable;
      },
    },
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
    diagnostics: [
      {
        ruleId: "document.catalog.invalid",
        severity: "error",
        subject: "docs/broken.md",
        message: "Document metadata is invalid.",
      },
    ],
  });
  const projection = await projectCommunityContext({
    searchIndex: createCommunityMiniSearchIndex(),
    catalogBefore: partial,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: {} },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "partial",
          catalogSemanticDigest: partial.semanticDigest,
          diagnostics: partial.diagnostics,
          documents: [],
        };
      },
      async buildCatalog() {
        return partial;
      },
    },
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
    searchIndex: createCommunityMiniSearchIndex(),
    catalogBefore: stable,
    foundationProfilePath: "docs.config.yaml",
    request: {
      consumerRoot: "/fixture",
      profilePath: "docs.config.yaml",
      query: { text: " cafe\u0301 ", owner: "platform", ranking: "fuzzy-advisory" },
      limits: { maxBytes: 4096, maxDocuments: 2 },
    },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "complete",
          catalogSemanticDigest: middleDigest,
          diagnostics: [],
          documents: [],
        };
      },
      async buildCatalog() {
        return stable;
      },
    },
  });

  assert.equal(projection.outcome, "authority-stale");
  assert.equal(projection.result.includedDocuments, 0);
  assert.equal(projection.result.omittedDocuments, 0);
  assert.equal(projection.result.truncated, false);
  assert.equal(projection.result.content, "");
  assert.deepEqual(projection.result.selection, {
    ranking: "fuzzy-advisory",
    query: { text: "café", owner: "platform" },
  });
  assert.deepEqual(projection.result.limits, { maxBytes: 4096, maxDocuments: 2 });
  assert.equal(Object.hasOwn(projection.result, "ranking"), false);
});

test("partial context deduplicates repeated snapshot diagnostics and preserves distinct evidence", async () => {
  const repeated = {
    ruleId: "document.catalog.invalid",
    severity: "error",
    subject: "docs/broken.md",
    message: "Document metadata is invalid.",
  };
  const distinct = { ...repeated, subject: "docs/other.md" };
  const overflow = Array.from({ length: 300 }, (_, index) => ({
    ...repeated,
    subject: `docs/overflow-${String(index).padStart(3, "0")}.md`,
  }));
  const before = catalog({ status: "partial", diagnostics: [repeated] });
  const after = catalog({ status: "partial", diagnostics: [repeated, distinct, ...overflow] });
  const projection = await projectCommunityContext({
    searchIndex: createCommunityMiniSearchIndex(),
    catalogBefore: before,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query: {} },
    foundation: {
      async findWithEvidence() {
        return {
          catalogStatus: "partial",
          catalogSemanticDigest: before.semanticDigest,
          diagnostics: [repeated, distinct, ...overflow],
          documents: [],
        };
      },
      async buildCatalog() {
        return after;
      },
    },
  });

  assert.equal(projection.outcome, "violation");
  assert.equal(projection.diagnostics.length, 256);
  assert.deepEqual(
    projection.diagnostics.slice(0, 2).map(({ subject }) => subject),
    ["docs/broken.md", "docs/other.md"],
  );
  assert.deepEqual(projection.diagnostics.at(-1), {
    ruleId: "docs.context.diagnostics-truncated",
    severity: "warning",
    phase: "authority",
    subject: "diagnostics",
    message:
      "Omitted 47 additional unique diagnostics after the deterministic 255-item context evidence limit.",
  });
});

test("community queries use the injected search index for find and context", async () => {
  const stable = catalog();
  const calls = [];
  const searchIndex = {
    replaceAll(records) {
      calls.push(records.map(({ id }) => id));
    },
    search(query) {
      calls.push(query);
      return [{ id: stable.documents[0].id, score: 42 }];
    },
  };
  const foundation = {
    async findWithEvidence() {
      return {
        catalogStatus: "complete",
        catalogSemanticDigest: stable.semanticDigest,
        diagnostics: [],
        documents: stable.documents,
      };
    },
    async buildCatalog() {
      return stable;
    },
  };
  const query = { text: "injected-provider-only", ranking: "fuzzy-advisory" };
  const found = await projectCommunityFind({
    consumerRoot: "/fixture",
    foundationProfilePath: "docs.config.yaml",
    query,
    foundation,
    searchIndex,
  });
  assert.equal(found.result.matches, 1);
  const context = await projectCommunityContext({
    catalogBefore: stable,
    foundationProfilePath: "docs.config.yaml",
    request: { consumerRoot: "/fixture", profilePath: "docs.config.yaml", query },
    foundation,
    searchIndex,
  });
  assert.equal(context.result.includedDocuments, 1);
  assert.deepEqual(calls, [
    [stable.documents[0].id],
    query.text,
    [stable.documents[0].id],
    query.text,
  ]);
});

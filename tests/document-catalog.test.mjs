import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  buildDocumentationCatalog,
  DocumentCatalogError,
  projectReferencedDocuments,
} from "../packages/engineering-foundation/dist/document-authoring/index.js";
import { BuildDocumentationCatalog } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/build-documentation-catalog.js";

const digest = `sha256:${"0".repeat(64)}`;

const metadataSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "status", "owner", "summary"],
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    status: { type: "string" },
    owner: { type: "string" },
    summary: { type: "string" },
    related: { type: "array", items: { type: "string" } },
  },
};

function profileSource(excludedPrefixes = ["docs/content/excluded"]) {
  return `schemaVersion: 1
projectId: fixture-project
catalog:
  metadataSchemaPath: docs/metadata.schema.json
  ownerCatalog:
    path: docs/owners.yaml
    contract: foundation.owner-map/v1
  collections:
    - kind: markdown-tree
      root: docs/content
    - kind: frontmatter-readme
      roots:
        - packages
  excludedPrefixes:
${excludedPrefixes.map((prefix) => `    - ${prefix}`).join("\n")}
authoring:
  mode: create-only
  artifactTypes:
    - type: adr
      initialStatus: proposed
      identity:
        kind: explicit
        format: adr-four-digits
      placement:
        kind: collection
        directory: docs/content
        filename: numeric-id-slug
      template:
        kind: fenced-markdown-body
        path: docs/template.md
      heading:
        kind: id-colon-title
      reachability:
        kind: not-required
`;
}

function documentSource({
  id,
  owner = "architecture",
  status = "active",
  summary = `Summary for ${id}.`,
  title = id,
  type = "guide",
}) {
  return `---
id: ${id}
type: ${type}
status: ${status}
owner: ${owner}
summary: ${summary}
---

# ${title}

Body.
`;
}

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-catalog-"));
  await Promise.all([
    mkdir(join(root, "docs", "content"), { recursive: true }),
    mkdir(join(root, "docs", "content", "excluded"), { recursive: true }),
    mkdir(join(root, "packages", "alpha"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "document-authoring.yaml"), profileSource(), "utf8"),
    writeFile(
      join(root, "docs", "metadata.schema.json"),
      `${JSON.stringify(metadataSchema, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(root, "docs", "owners.yaml"),
      "version: 1\nowners:\n  architecture:\n    kind: architecture\n",
      "utf8",
    ),
  ]);
  return root;
}

test("builds one deterministic read-only catalog across collection kinds", async () => {
  const root = await createConsumer();
  try {
    await Promise.all([
      writeFile(
        join(root, "docs", "content", "zeta.md"),
        documentSource({ id: "guide.zeta", title: "Zeta" }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "alpha.md"),
        documentSource({ id: "guide.alpha", title: "Alpha" }),
        "utf8",
      ),
      writeFile(
        join(root, "packages", "alpha", "README.md"),
        documentSource({ id: "package.alpha", title: "Alpha package" }),
        "utf8",
      ),
      writeFile(
        join(root, "packages", "alpha", "ignored.md"),
        Buffer.from([0xff, 0xfe]),
      ),
      writeFile(
        join(root, "docs", "content", "excluded", "invalid.md"),
        Buffer.from([0xff]),
      ),
    ]);
    const authorityAndSources = [
      "document-authoring.yaml",
      "docs/metadata.schema.json",
      "docs/owners.yaml",
      "docs/content/alpha.md",
      "docs/content/zeta.md",
      "packages/alpha/README.md",
    ];
    const before = await Promise.all(
      authorityAndSources.map((path) => readFile(join(root, path))),
    );

    const first = await buildDocumentationCatalog({
      consumerRoot: root,
      profilePath: "document-authoring.yaml",
    });
    const second = await buildDocumentationCatalog({
      consumerRoot: root,
      profilePath: "document-authoring.yaml",
    });
    assert.deepEqual(
      await Promise.all(authorityAndSources.map((path) => readFile(join(root, path)))),
      before,
    );
    assert.deepEqual(second, first);
    assert.equal(first.status, "complete");
    assert.deepEqual(
      first.documents.map(({ id, repositoryPath, source, title }) => ({
        id,
        repositoryPath,
        source,
        title,
      })),
      [
        {
          id: "guide.alpha",
          repositoryPath: "docs/content/alpha.md",
          source: "markdown-tree",
          title: "Alpha",
        },
        {
          id: "guide.zeta",
          repositoryPath: "docs/content/zeta.md",
          source: "markdown-tree",
          title: "Zeta",
        },
        {
          id: "package.alpha",
          repositoryPath: "packages/alpha/README.md",
          source: "frontmatter-readme",
          title: "Alpha package",
        },
      ],
    );
    assert.deepEqual(projectReferencedDocuments(first, ["package.alpha", "missing", "package.alpha"]), {
      documents: [{ id: "package.alpha", path: "packages/alpha/README.md" }],
      missingIds: ["missing"],
      unresolvedIds: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns a partial catalog without hiding valid neighbors", async () => {
  const root = await createConsumer();
  try {
    await Promise.all([
      writeFile(
        join(root, "docs", "content", "valid.md"),
        documentSource({ id: "guide.valid", title: "Valid" }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "duplicate-a.md"),
        documentSource({ id: "guide.duplicate", title: "Duplicate A" }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "duplicate-b.md"),
        documentSource({ id: "guide.duplicate", title: "Duplicate B" }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "unknown-owner.md"),
        documentSource({ id: "guide.unknown", owner: "missing", title: "Unknown" }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "metadata-invalid.md"),
        documentSource({ id: "guide.metadata-invalid", title: "Metadata invalid" })
          .replace("\n---\n\n#", "\nextra: rejected\n---\n\n#"),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "descriptor-invalid.md"),
        documentSource({ id: "guide.descriptor-invalid", title: "Descriptor invalid" })
          .replace(/summary: .*\n/u, "summary:\n"),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "malformed.md"),
        "---\nid: broken\n# Missing delimiter\n",
        "utf8",
      ),
    ]);
    const snapshot = await buildDocumentationCatalog({
      consumerRoot: root,
      profilePath: "document-authoring.yaml",
    });
    assert.equal(snapshot.status, "partial");
    assert.equal(snapshot.documents.some((document) => document.id === "guide.valid"), true);
    assert.equal(snapshot.documents.some((document) => document.id === "guide.unknown"), false);
    assert.equal(
      snapshot.identityProjection.some((entry) => entry.id === "guide.unknown"),
      true,
    );
    assert.equal(
      snapshot.identityProjection.some(
        (entry) => entry.id === "guide.descriptor-invalid",
      ),
      true,
    );
    assert.deepEqual(
      projectReferencedDocuments(snapshot, [
        "guide.unknown",
        "guide.duplicate",
        "missing",
      ]),
      {
        documents: [],
        missingIds: ["missing"],
        unresolvedIds: ["guide.duplicate", "guide.unknown"],
      },
    );
    assert.deepEqual(
      [...new Set(snapshot.diagnostics.map((entry) => entry.ruleId))],
      [
        "document.catalog.descriptor-invalid",
        "document.catalog.duplicate-id",
        "document.catalog.frontmatter-invalid",
        "document.catalog.metadata-invalid",
        "document.catalog.owner-unknown",
      ],
    );
    assert.equal(
      snapshot.documents.some(({ id }) => id === "guide.duplicate"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports malformed UTF-8, BOM, and NUL sources while preserving valid documents", async () => {
  const root = await createConsumer();
  try {
    await Promise.all([
      writeFile(
        join(root, "docs", "content", "valid.md"),
        documentSource({ id: "guide.valid" }),
        "utf8",
      ),
      writeFile(join(root, "docs", "content", "utf8.md"), Buffer.from([0xff])),
      writeFile(
        join(root, "docs", "content", "bom.md"),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# BOM\n")]),
      ),
      writeFile(
        join(root, "docs", "content", "nul.md"),
        Buffer.from("# NUL\u0000\n"),
      ),
    ]);
    const snapshot = await buildDocumentationCatalog({
      consumerRoot: root,
      profilePath: "document-authoring.yaml",
    });
    assert.equal(snapshot.documents.length, 1);
    assert.deepEqual(
      snapshot.diagnostics.map((entry) => entry.ruleId),
      [
        "document.catalog.source-invalid",
        "document.catalog.source-invalid",
        "document.catalog.source-invalid",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects remote metadata schema references before discovery", async () => {
  const root = await createConsumer();
  try {
    const remoteSchema = structuredClone(metadataSchema);
    remoteSchema.properties.owner = { $ref: "https://example.invalid/owner.json" };
    await writeFile(
      join(root, "docs", "metadata.schema.json"),
      `${JSON.stringify(remoteSchema)}\n`,
      "utf8",
    );
    await assert.rejects(
      buildDocumentationCatalog({
        consumerRoot: root,
        profilePath: "document-authoring.yaml",
      }),
      (error) =>
        error instanceof DocumentCatalogError &&
        error.code === "DOCUMENT_CATALOG_INPUT_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects async metadata schemas before exposing the synchronous validator", async () => {
  const root = await createConsumer();
  try {
    await writeFile(
      join(root, "docs", "metadata.schema.json"),
      `${JSON.stringify({ ...metadataSchema, $async: true })}\n`,
      "utf8",
    );
    await assert.rejects(
      buildDocumentationCatalog({
        consumerRoot: root,
        profilePath: "document-authoring.yaml",
      }),
      (error) =>
        error instanceof DocumentCatalogError &&
        error.code === "DOCUMENT_CATALOG_INPUT_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function observedDocument(repositoryPath, id) {
  const source = documentSource({ id, title: id });
  return {
    anchorObservations: [],
    frontmatter: {
      endOffset: source.indexOf("# "),
      kind: "valid",
      value: {
        id,
        type: "guide",
        status: "active",
        owner: "architecture",
        summary: `Summary for ${id}.`,
      },
    },
    headings: [{ depth: 1, location: { column: 1, line: 9, offset: source.indexOf("# ") }, text: id }],
    references: [],
    repositoryPath,
    source,
  };
}

function fakeBuilder(documents, overrides = {}) {
  let ownerReads = 0;
  let repositoryReads = 0;
  const evidence = (path) => ({ digest, path, size: 1 });
  return new BuildDocumentationCatalog({
    metadata: {
      async load() {
        return {
          evidence: evidence("docs/metadata.schema.json"),
          validate: () => ({ messages: [], valid: true }),
        };
      },
    },
    owners: {
      async read() {
        ownerReads += 1;
        if (overrides.ownerDisappears === true && ownerReads === 2) {
          throw new DocumentCatalogError(
            "DOCUMENT_CATALOG_AUTHORITY_UNAVAILABLE",
            "owner map disappeared",
          );
        }
        return { evidence: evidence("docs/owners.yaml"), ids: ["architecture"] };
      },
    },
    profile: {
      async read() {
        return {
          collections: [{ kind: "markdown-tree", root: "docs" }],
          evidence: evidence("document-authoring.yaml"),
          excludedPrefixes: [],
          metadataSchemaPath: "docs/metadata.schema.json",
          ownerCatalog: { contract: "foundation.owner-map/v1", path: "docs/owners.yaml" },
          projectId: "fixture-project",
        };
      },
    },
    repository: {
      async observe() {
        repositoryReads += 1;
        return {
          documents:
            overrides.corpusChanges === true && repositoryReads === 2
              ? [...documents, observedDocument("docs/new.md", "guide.new")]
              : documents,
          issues: overrides.issues ?? [],
        };
      },
      async resolveReference() {
        throw new Error("not used");
      },
    },
  });
}

test("detects case and NFC path collisions independently of the host filesystem", async () => {
  const documents = [observedDocument("docs/Caf\u00e9.md", "guide.composed")];
  const snapshot = await fakeBuilder(documents, {
    issues: [
      {
        kind: "source-invalid",
        message: "Malformed UTF-8.",
        repositoryPath: "docs/cafe\u0301.md",
      },
    ],
  }).execute({ consumerRoot: "/fixture", profilePath: "document-authoring.yaml" });
  assert.equal(snapshot.status, "partial");
  assert.equal(
    snapshot.diagnostics.some(
      (entry) => entry.ruleId === "document.catalog.normalized-path-collision",
    ),
    true,
  );
});

test("fails closed when owner authority disappears during observation", async () => {
  await assert.rejects(
    fakeBuilder([observedDocument("docs/valid.md", "guide.valid")], {
      ownerDisappears: true,
    }).execute({ consumerRoot: "/fixture", profilePath: "document-authoring.yaml" }),
    (error) =>
      error instanceof DocumentCatalogError &&
      error.code === "DOCUMENT_CATALOG_AUTHORITY_CHANGED",
  );
});

test("marks a catalog partial when the corpus changes between passes", async () => {
  const snapshot = await fakeBuilder(
    [observedDocument("docs/valid.md", "guide.valid")],
    { corpusChanges: true },
  ).execute({ consumerRoot: "/fixture", profilePath: "document-authoring.yaml" });
  assert.equal(snapshot.status, "partial");
  assert.equal(
    snapshot.diagnostics.some(
      (entry) => entry.ruleId === "document.catalog.corpus-changed",
    ),
    true,
  );
});

test("catalog output is permutation invariant", async () => {
  const ordered = [
    observedDocument("docs/a.md", "guide.a"),
    observedDocument("docs/b.md", "guide.b"),
    observedDocument("docs/c.md", "guide.c"),
  ];
  const request = { consumerRoot: "/fixture", profilePath: "document-authoring.yaml" };
  const left = await fakeBuilder(ordered).execute(request);
  const right = await fakeBuilder(ordered.toReversed()).execute(request);
  assert.deepEqual(right, left);
});

test("qualifies pure catalog projections without performance timing", async (context) => {
  for (const count of [3, 100]) {
    await context.test(`${count} documents`, async () => {
      const documents = Array.from({ length: count }, (_, index) => {
        const sequence = String(index).padStart(5, "0");
        return observedDocument(`docs/${sequence}.md`, `guide.${sequence}`);
      });
      const snapshot = await fakeBuilder(documents).execute({
        consumerRoot: "/fixture",
        profilePath: "document-authoring.yaml",
      });
      assert.equal(snapshot.status, "complete");
      assert.equal(snapshot.documents.length, count);
    });
  }
});

async function writeDocumentCorpus(root, count) {
  const paths = Array.from({ length: count }, (_, index) => {
    const sequence = String(index).padStart(5, "0");
    return {
      path: join(root, "docs", "content", `${sequence}.md`),
      source: documentSource({ id: `guide.${sequence}`, title: `Guide ${sequence}` }),
    };
  });
  for (let index = 0; index < paths.length; index += 200) {
    await Promise.all(
      paths.slice(index, index + 200).map(({ path, source }) =>
        writeFile(path, source, "utf8")),
    );
  }
}

const advisoryTest = process.env.FOUNDATION_PERFORMANCE === "1" ? test : test.skip;
const performanceDocumentCounts = process.env.FOUNDATION_PERFORMANCE_COUNTS === undefined
  ? [100, 1_000, 5_000]
  : process.env.FOUNDATION_PERFORMANCE_COUNTS.split(",").map(Number);

advisoryTest("collects advisory cold and warm filesystem benchmarks at 100, 1,000, and 5,000 documents", async (context) => {
  for (const count of performanceDocumentCounts) {
    await context.test(`${count} documents`, async (subtest) => {
      const root = await createConsumer();
      try {
        await writeDocumentCorpus(root, count);
        const request = {
          consumerRoot: root,
          profilePath: "document-authoring.yaml",
        };
        const coldStarted = performance.now();
        const cold = await buildDocumentationCatalog(request);
        const coldMilliseconds = performance.now() - coldStarted;
        const warmStarted = performance.now();
        const warm = await buildDocumentationCatalog(request);
        const warmMilliseconds = performance.now() - warmStarted;
        assert.equal(cold.status, "complete");
        assert.equal(cold.documents.length, count);
        assert.deepEqual(warm, cold);
        subtest.diagnostic(`FOUNDATION_BENCHMARK ${JSON.stringify({
          benchmark: "document-catalog-filesystem",
          count,
          measurements: {
            coldMilliseconds,
            warmMilliseconds,
          },
        })}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

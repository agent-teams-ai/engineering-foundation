import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import {
  findDocumentationDocuments,
} from "../packages/engineering-foundation/dist/document-authoring/index.js";
import { FindDocuments } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/find-documents.js";
import {
  documentFindFailure,
  documentFindSuccess,
} from "../packages/engineering-foundation/dist/document-authoring/find-command.js";
import { DocumentCatalogError } from "../packages/engineering-foundation/dist/document-authoring/document-catalog-error.js";

const cliPath = fileURLToPath(
  new URL("../packages/engineering-foundation/dist/cli.js", import.meta.url),
);

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
  },
};

function profileSource() {
  return `schemaVersion: 1
projectId: find-fixture
catalog:
  metadataSchemaPath: docs/metadata.schema.json
  ownerCatalog:
    path: docs/owners.yaml
    contract: foundation.owner-map/v1
  collections:
    - kind: markdown-tree
      root: docs/content
  excludedPrefixes: []
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
  body = "Body.",
  heading = "Heading",
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

## ${heading}

${body}
`;
}

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-find-"));
  await mkdir(join(root, "architecture", "foundation"), { recursive: true });
  await mkdir(join(root, "docs", "content"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "architecture", "foundation", "document-authoring.yaml"),
      profileSource(),
      "utf8",
    ),
    writeFile(
      join(root, "docs", "metadata.schema.json"),
      `${JSON.stringify(metadataSchema)}\n`,
      "utf8",
    ),
    writeFile(
      join(root, "docs", "owners.yaml"),
      "version: 1\nowners:\n  architecture:\n    kind: architecture\n  product:\n    kind: product\n",
      "utf8",
    ),
  ]);
  return root;
}

function request(root, query) {
  return {
    consumerRoot: root,
    profilePath: "architecture/foundation/document-authoring.yaml",
    ...(query === undefined ? {} : { query }),
  };
}

test("finds literal Unicode text across all specified fields with AND filters", async () => {
  const root = await createConsumer();
  try {
    await Promise.all([
      writeFile(
        join(root, "docs", "content", "zeta.md"),
        documentSource({
          body: "Deployment body needle.",
          heading: "Runbook heading",
          id: "guide.zeta",
          owner: "product",
          status: "draft",
          summary: "Cafe\u0301 operations",
          title: "Zeta title",
          type: "runbook",
        }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "alpha.md"),
        documentSource({
          body: "Other body.",
          heading: "Other heading",
          id: "guide.alpha",
          title: "Alpha title",
        }),
        "utf8",
      ),
    ]);

    for (const text of [
      "GUIDE.ZETA",
      "zeta TITLE",
      "CAFÉ OPERATIONS",
      "RUNBOOK HEADING",
      "BODY NEEDLE",
    ]) {
      const result = await findDocumentationDocuments(request(root, { text }));
      assert.deepEqual(result.documents.map(({ id }) => id), ["guide.zeta"]);
    }
    const filtered = await findDocumentationDocuments(request(root, {
      filters: {
        id: "guide.zeta",
        owner: "product",
        status: "draft",
        type: "runbook",
      },
      text: "deployment",
    }));
    assert.deepEqual(filtered.documents.map(({ id }) => id), ["guide.zeta"]);
    const rejectedByAnd = await findDocumentationDocuments(request(root, {
      filters: { owner: "architecture", type: "runbook" },
      text: "deployment",
    }));
    assert.equal(rejectedByAnd.matches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns deterministic id/path ordering, exact literals, and zero-match success data", async () => {
  const root = await createConsumer();
  try {
    await Promise.all([
      writeFile(
        join(root, "docs", "content", "z.md"),
        documentSource({ id: "guide.same", title: "Shared literal" }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "a.md"),
        documentSource({ id: "guide.same", title: "Shared literal" }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "b.md"),
        documentSource({ id: "guide.beta", title: "Shared literal" }),
        "utf8",
      ),
    ]);
    const first = await findDocumentationDocuments(request(root, { text: "literal" }));
    const second = await findDocumentationDocuments(request(root, { text: "literal" }));
    assert.deepEqual(second, first);
    assert.deepEqual(
      first.documents.map(({ id, repositoryPath }) => ({ id, repositoryPath })),
      [
        { id: "guide.beta", repositoryPath: "docs/content/b.md" },
        { id: "guide.same", repositoryPath: "docs/content/a.md" },
        { id: "guide.same", repositoryPath: "docs/content/z.md" },
      ],
    );
    assert.equal(first.catalogStatus, "partial");
    const noFuzzy = await findDocumentationDocuments(request(root, { text: "lteral" }));
    assert.deepEqual(noFuzzy, {
      catalogStatus: "partial",
      diagnostics: first.diagnostics,
      documents: [],
      matches: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI emits one schema-valid JSON object, partial diagnostics, and never writes an index", async () => {
  const root = await createConsumer();
  try {
    await Promise.all([
      writeFile(
        join(root, "docs", "content", "valid.md"),
        documentSource({ id: "guide.valid", title: "Valid guide" }),
        "utf8",
      ),
      writeFile(
        join(root, "docs", "content", "invalid.md"),
        "# Missing frontmatter\n",
        "utf8",
      ),
    ]);
    const before = await Promise.all([
      readFile(join(root, "docs", "content", "valid.md")),
      readdir(root, { recursive: true }),
    ]);
    const result = spawnSync(process.execPath, [
      cliPath,
      "docs",
      "find",
      "valid",
      "--consumer",
      root,
      "--json",
    ], { encoding: "utf8", env: { ...process.env, LANG: "tr_TR.UTF-8" } });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(`${JSON.stringify(output)}\n`, result.stdout);
    await assertSchema("document-command-envelope/v1", output, "docs-find-cli");
    assert.equal(output.outcome, "partial");
    assert.equal(output.result.matches, 1);
    assert.deepEqual(output.result.documents.map(({ id }) => id), ["guide.valid"]);
    assert.equal(output.diagnostics[0].phase, "query");
    const human = spawnSync(process.execPath, [
      cliPath,
      "docs",
      "find",
      "valid",
      "--consumer",
      root,
    ], { encoding: "utf8" });
    assert.equal(human.status, 1, human.stderr);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /^Catalog: partial\nMatches: 1\n/u);
    assert.match(human.stdout, /guide\.valid \[guide\/active\] docs\/content\/valid\.md/u);
    assert.match(human.stdout, /ERROR document\.catalog\.frontmatter-required/u);
    assert.deepEqual(
      await Promise.all([
        readFile(join(root, "docs", "content", "valid.md")),
        readdir(root, { recursive: true }),
      ]),
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds schema output and maps closed failure outcomes deterministically", async () => {
  const documents = Array.from({ length: 3_000 }, (_, index) => descriptor(index));
  const diagnostics = Array.from({ length: 300 }, (_, index) => ({
    message: `Diagnostic ${index}`,
    ruleId: `document.catalog.fixture-${index}`,
    severity: "error",
    subject: `docs/${index}.md`,
  }));
  const partial = documentFindSuccess({
    catalogStatus: "partial",
    diagnostics,
    documents,
    matches: documents.length,
  });
  assert.equal(partial.exitCode, 1);
  assert.equal(partial.envelope.result.matches, 3_000);
  assert.equal(partial.envelope.result.documents.length, 2_048);
  assert.equal(partial.envelope.diagnostics.length, 256);
  assert.equal(
    partial.envelope.diagnostics.at(-1).ruleId,
    "document.query.diagnostics-truncated",
  );
  await assertSchema(
    "document-command-envelope/v1",
    partial.envelope,
    "bounded-docs-find",
  );

  const stale = documentFindFailure(new DocumentCatalogError(
    "DOCUMENT_CATALOG_AUTHORITY_CHANGED",
    "Authority changed.",
  ));
  assert.equal(stale.exitCode, 1);
  assert.equal(stale.envelope.outcome, "authority-stale");
  await assertSchema("document-command-envelope/v1", stale.envelope, "stale-docs-find");

  const failed = documentFindFailure(new Error("Unexpected adapter failure."));
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.envelope.outcome, "execution-failure");
  await assertSchema("document-command-envelope/v1", failed.envelope, "failed-docs-find");
});

test("CLI reports zero matches as success and invalid JSON invocations structurally", async () => {
  const root = await createConsumer();
  try {
    await writeFile(
      join(root, "docs", "content", "valid.md"),
      documentSource({ id: "guide.valid" }),
      "utf8",
    );
    const zero = spawnSync(process.execPath, [
      cliPath,
      "docs",
      "find",
      "absent",
      "--consumer",
      root,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(zero.status, 0, zero.stderr);
    assert.deepEqual(JSON.parse(zero.stdout).result, {
      kind: "find",
      matches: 0,
      documents: [],
    });

    for (const args of [
      ["docs", "find", "one", "two", "--json"],
      ["docs", "find", "--id", "", "--json"],
      ["docs", "find", "--type", "INVALID", "--consumer", root, "--json"],
    ]) {
      const invalid = spawnSync(process.execPath, [cliPath, ...args], {
        encoding: "utf8",
      });
      assert.equal(invalid.status, 2, invalid.stderr);
      assert.equal(invalid.stderr, "");
      const output = JSON.parse(invalid.stdout);
      assert.equal(output.outcome, "invalid-input");
      await assertSchema("document-command-envelope/v1", output, "invalid-docs-find");
    }

    const missingConsumer = spawnSync(process.execPath, [
      cliPath,
      "docs",
      "find",
      "--consumer",
      join(root, "missing"),
      "--json",
    ], { encoding: "utf8" });
    assert.equal(missingConsumer.status, 2);
    assert.equal(missingConsumer.stderr, "");
    const missingOutput = JSON.parse(missingConsumer.stdout);
    assert.equal(missingOutput.outcome, "invalid-input");
    await assertSchema(
      "document-command-envelope/v1",
      missingOutput,
      "missing-consumer-docs-find",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes non-portable document paths from schema-bound command output", async () => {
  const root = await createConsumer();
  try {
    await writeFile(
      join(root, "docs", "content", "café.md"),
      documentSource({ id: "guide.unicode", title: "Unicode path" }),
      "utf8",
    );
    const result = spawnSync(process.execPath, [
      cliPath,
      "docs",
      "find",
      "unicode",
      "--consumer",
      root,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.outcome, "partial");
    assert.equal(output.result.matches, 0);
    assert.equal(output.diagnostics[0].ruleId, "document.catalog.path-invalid");
    await assertSchema("document-command-envelope/v1", output, "portable-path-docs-find");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function descriptor(index) {
  const sequence = String(index).padStart(5, "0");
  return Object.freeze({
    id: `guide.${sequence}`,
    owner: "architecture",
    repositoryPath: `docs/${sequence}.md`,
    source: "markdown-tree",
    status: "active",
    summary: `Summary ${sequence}`,
    title: `Guide ${sequence}`,
    type: "guide",
  });
}

function searchSnapshot(count) {
  const documents = Array.from({ length: count }, (_, index) => {
    const item = descriptor(index);
    return Object.freeze({
      body: `Body ${index === count - 1 ? "target" : "ordinary"}`,
      descriptor: item,
      headings: Object.freeze([item.title]),
    });
  });
  return Object.freeze({
    catalog: Object.freeze({
      authority: Object.freeze({}),
      diagnostics: Object.freeze([]),
      documents: Object.freeze(documents.map(({ descriptor: item }) => item)),
      identityProjection: Object.freeze([]),
      ownerIds: Object.freeze(["architecture"]),
      projectId: "benchmark",
      status: "complete",
    }),
    documents: Object.freeze(documents),
  });
}

test("qualifies deterministic in-memory query behavior at 100, 1,000, and 5,000 documents", async (context) => {
  for (const count of [100, 1_000, 5_000]) {
    await context.test(`${count} documents`, async (subtest) => {
      const snapshot = searchSnapshot(count);
      const finder = new FindDocuments({ async read() { return snapshot; } });
      const started = performance.now();
      const result = await finder.execute({
        consumerRoot: "/fixture",
        profilePath: "document-authoring.yaml",
        query: { text: "target" },
      });
      const elapsedMilliseconds = performance.now() - started;
      assert.deepEqual(result.documents.map(({ id }) => id), [
        `guide.${String(count - 1).padStart(5, "0")}`,
      ]);
      subtest.diagnostic(
        `document query benchmark ${count}: ${elapsedMilliseconds.toFixed(1)}ms`,
      );
    });
  }
});

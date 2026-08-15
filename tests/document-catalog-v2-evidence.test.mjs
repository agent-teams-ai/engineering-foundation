import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDocumentationCatalog,
  buildDocumentationCatalogV2,
  describeDocumentAuthoringProfileV2,
  findDocumentationDocumentsV2,
} from "../packages/engineering-foundation/dist/document-authoring/index.js";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: true,
  properties: Object.fromEntries(
    ["id", "owner", "status", "summary", "type"].map((key) => [
      key,
      { type: "string" },
    ]),
  ),
  required: ["id", "type", "status", "owner", "summary"],
  type: "object",
};

const profileV1 = `schemaVersion: 1
projectId: evidence-fixture
catalog:
  metadataSchemaPath: docs/metadata.schema.json
  ownerCatalog: {path: docs/owners.yaml, contract: foundation.owner-map/v1}
  collections:
    - {kind: markdown-tree, root: docs/content}
  excludedPrefixes: []
authoring:
  mode: create-only
  artifactTypes:
    - type: guide
      initialStatus: active
      identity: {kind: explicit, format: adr-four-digits}
      placement: {kind: collection, directory: docs/content, filename: numeric-id-slug}
      template: {kind: fenced-markdown-body, path: docs/template.md}
      heading: {kind: title}
      reachability: {kind: not-required}
`;

const profileV2 = profileV1
  .replace("schemaVersion: 1", "schemaVersion: 2")
  .replace("    - type: guide\n", "    - type: guide\n      allowedOwnerIds: [architecture]\n")
  .replace(
    "reachability: {kind: not-required}",
    "reachability: {kind: not-required, reason: No governed index.}",
  );

function documentSource(status = "active", extra = "") {
  return `---
id: guide.evidence
type: guide
status: ${status}
owner: architecture
summary: Evidence guide.
${extra}---

# Evidence guide

Body.
`;
}

async function createConsumer(profile = profileV1) {
  const root = await mkdtemp(join(tmpdir(), "document-catalog-v2-evidence-"));
  await mkdir(join(root, "docs", "content"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "document-authoring.yaml"), profile, "utf8"),
    writeFile(join(root, "docs", "metadata.schema.json"), JSON.stringify(schema), "utf8"),
    writeFile(
      join(root, "docs", "owners.yaml"),
      "version: 1\nowners:\n  architecture: {kind: architecture}\n",
      "utf8",
    ),
    writeFile(
      join(root, "docs", "template.md"),
      "```markdown\n---\nid: placeholder\ntype: guide\nstatus: active\nowner: architecture\nsummary: Placeholder.\n---\n\n# Placeholder\n```\n",
      "utf8",
    ),
    writeFile(
      join(root, "docs", "content", "evidence.md"),
      documentSource(),
      "utf8",
    ),
  ]);
  return root;
}

test("catalog/find v2 bind full semantic metadata without changing v1", async () => {
  const root = await createConsumer();
  try {
    const request = { consumerRoot: root, profilePath: "document-authoring.yaml" };
    const v1 = await buildDocumentationCatalog(request);
    await writeFile(join(root, "document-authoring.yaml"), profileV2, "utf8");
    const v2 = await buildDocumentationCatalogV2(request);
    const found = await findDocumentationDocumentsV2({
      ...request,
      query: { filters: { id: "guide.evidence" } },
    });
    assert.equal(Object.hasOwn(v1.documents[0], "metadata"), false);
    assert.equal(found.catalogSemanticDigest, v2.semanticDigest);
    assert.match(v2.semanticDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(v2.documents[0].metadata), true);

    await writeFile(
      join(root, "docs", "content", "evidence.md"),
      documentSource("blocked", "blocked_by: [guide.blocker]\n"),
      "utf8",
    );
    const changed = await buildDocumentationCatalogV2(request);
    assert.notEqual(changed.semanticDigest, v2.semanticDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("description v2 binds template and normalized reachability authority", async () => {
  const root = await createConsumer(profileV2);
  try {
    const request = { consumerRoot: root, profilePath: "document-authoring.yaml" };
    const first = await describeDocumentAuthoringProfileV2(request);
    assert.match(first.semanticDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(
      first.authority.templates.map(({ evidence, type }) => ({
        path: evidence.path,
        type,
      })),
      [{ path: "docs/template.md", type: "guide" }],
    );

    await writeFile(
      join(root, "docs", "template.md"),
      "```markdown\n---\nid: changed\ntype: guide\nstatus: active\nowner: architecture\nsummary: Changed.\n---\n\n# Changed\n```\n",
      "utf8",
    );
    const templateChanged = await describeDocumentAuthoringProfileV2(request);
    assert.notEqual(templateChanged.semanticDigest, first.semanticDigest);

    await writeFile(
      join(root, "document-authoring.yaml"),
      profileV2.replace("No governed index.", "Reachability policy changed."),
      "utf8",
    );
    const reachabilityChanged = await describeDocumentAuthoringProfileV2(request);
    assert.notEqual(
      reachabilityChanged.semanticDigest,
      templateChanged.semanticDigest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { FilesystemMarkdownRepository } from "../packages/engineering-foundation/dist/documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { analyzeDocumentationLocalReferences } from "../packages/engineering-foundation/dist/capabilities/documentation-local-references/application/use-cases/analyze-documentation-local-references.js";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/documentation-local-references/contract/config.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "documentation-local-references",
  "valid"
);
const configSchemaPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "schemas",
  "documentation-local-references",
  "v1.schema.json"
);

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-documentation-references-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function analyze(root) {
  const policy = await loadCapabilityConfig(root, "documentation-local-references.yaml");
  return analyzeDocumentationLocalReferences(
    { consumerRoot: root, policy },
    { repository: new FilesystemMarkdownRepository() }
  );
}

function ruleIds(diagnostics) {
  return diagnostics.map((diagnostic) => diagnostic.ruleId).toSorted();
}

test("accepts Markdown links, images, definitions, directory README targets, and duplicate GitHub anchors", async () => {
  await withFixture(async (root) => {
    const diagnostics = await analyze(root);
    assert.deepEqual(diagnostics, []);
  });
});

test("validates the explicit local-reference configuration schema", async () => {
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(JSON.parse(await readFile(configSchemaPath, "utf8")));
  await withFixture(async (root) => {
    const config = await loadCapabilityConfig(root, "documentation-local-references.yaml");
    assert.equal(
      validate({
        anchorProfile: config.anchorProfile,
        markdownRoots: config.markdownRoots,
        schemaVersion: 1
      }),
      true,
      JSON.stringify(validate.errors)
    );
    assert.equal(
      validate({
        anchorProfile: "github",
        markdownRoots: ["docs"],
        schemaVersion: 1,
        unsupported: true
      }),
      false
    );
  });
});

test("rejects broken image and definition targets while ignoring Markdown code", async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, "docs", "README.md"),
      `# Documentation\n\n![Missing](assets/missing.png)\n\n[Missing reference][missing-reference]\n\n[missing-reference]: ./missing.md\n\n\`[Ignored](also-missing.md)\`\n\n\`\`\`md\n[Ignored](fenced-missing.md)\n\`\`\`\n`,
      "utf8"
    );
    assert.deepEqual(ruleIds(await analyze(root)), [
      "documentation.local-references.broken-link",
      "documentation.local-references.broken-link"
    ]);
  });
});

test("rejects repository escapes and symbolic link traversal without following them", async () => {
  await withFixture(async (root) => {
    const outsidePath = join(dirname(root), "outside-markdown.md");
    await writeFile(outsidePath, "# Outside\n", "utf8");
    await symlink(outsidePath, join(root, "docs", "external.md"));
    await writeFile(
      join(root, "docs", "README.md"),
      "# Documentation\n\n[Escape](../../outside-markdown.md)\n\n[Unsafe](external.md)\n",
      "utf8"
    );
    const ids = ruleIds(await analyze(root));
    assert.ok(ids.includes("documentation.local-references.repository-escape"));
    assert.ok(ids.includes("documentation.local-references.symbolic-link"));
  });
});

test("requires an explicit anchor profile and permits a deliberate no-anchor profile", async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, "documentation-local-references.yaml"),
      "schemaVersion: 1\nmarkdownRoots:\n  - docs\n",
      "utf8"
    );
    await assert.rejects(
      loadCapabilityConfig(root, "documentation-local-references.yaml"),
      /anchorProfile/u
    );

    await writeFile(
      join(root, "documentation-local-references.yaml"),
      "schemaVersion: 1\nmarkdownRoots:\n  - docs\nanchorProfile: none\n",
      "utf8"
    );
    await writeFile(
      join(root, "docs", "README.md"),
      "# Documentation\n\n[Unknown fragment](guide/README.md#missing-anchor)\n",
      "utf8"
    );
    assert.deepEqual(await analyze(root), []);
  });
});

test("reports missing directory README targets separately", async () => {
  await withFixture(async (root) => {
    await rm(join(root, "docs", "guide", "README.md"));
    assert.deepEqual(ruleIds(await analyze(root)), [
      "documentation.local-references.broken-link",
      "documentation.local-references.broken-link",
      "documentation.local-references.directory-readme-missing"
    ]);
  });
});

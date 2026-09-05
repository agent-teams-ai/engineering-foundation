import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { actualSourceDependenciesCLI, copySourcePolicyFixture, observeFoundationFeatureGraph } from "./helpers/local-mode-boundaries.mjs";

import { Ajv2020 } from "ajv/dist/2020.js";

import { FilesystemMarkdownRepository } from "../packages/document-authoring/dist/documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { anchorsForMarkdownDocument } from "../packages/document-authoring/dist/documentation-observation/application/model/markdown-document.js";
import { analyzeDocumentationLocalReferences } from "../packages/engineering-foundation/dist/capabilities/documentation-local-references/application/use-cases/analyze-documentation-local-references.js";
import { loadCapabilityConfig as loadWithDependencies } from "../packages/engineering-foundation/dist/capabilities/documentation-local-references/adapters/inbound/configuration/load-capability-config.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { loadStrictYamlFile } from "../packages/engineering-foundation/dist/features/configuration-input/node.js";
const loadCapabilityConfig = (root, path, signal) => loadWithDependencies({ assertSchema, readYaml: loadStrictYamlFile }, root, path, signal);

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

test("re-reads changed Markdown between observations and checks", async () => {
  await withFixture(async (root) => {
    const repository = new FilesystemMarkdownRepository();
    const policy = await loadCapabilityConfig(root, "documentation-local-references.yaml");
    const initial = await analyzeDocumentationLocalReferences(
      { consumerRoot: root, policy },
      { repository }
    );
    assert.deepEqual(initial, []);

    const readmePath = join(root, "docs", "README.md");
    await writeFile(
      readmePath,
      "# Changed documentation\n\n[Missing target](missing.md)\n",
      "utf8"
    );

    const observation = await repository.observe({
      consumerRoot: root,
      roots: ["docs"]
    });
    const changedDocument = observation.documents.find(
      (document) => document.repositoryPath === "docs/README.md"
    );
    assert.equal(changedDocument?.source, "# Changed documentation\n\n[Missing target](missing.md)\n");

    assert.deepEqual(
      ruleIds(
        await analyzeDocumentationLocalReferences(
          { consumerRoot: root, policy },
          { repository }
        )
      ),
      ["documentation.local-references.broken-link"]
    );
  });
});

test("observes CommonMark and GFM links through the AST without scanning escaped or code content", async () => {
  await withFixture(async (root) => {
    const readmePath = join(root, "docs", "README.md");
    const tick = "`";
    const source = [
      "\uFEFF---",
      "title: Markdown AST coverage",
      "---",
      "",
      "# C++ & C#",
      "# C++ & C#",
      `## API *guide* with ${tick}code${tick}`,
      "",
      "[Reference usage][guide-reference]",
      "![Reference image][asset-reference]",
      "[URI target](guide/space%20file.md#caf%C3%A9)",
      "[Shortcut reference]",
      "[Collapsed reference][]",
      "[Escaped \\[label\\]](guide/README.md#install)",
      "",
      "| Guide |",
      "| --- |",
      "| [GFM table link](guide/README.md#install-1) |",
      "",
      "[guide-reference]: ./guide/README.md#install-1",
      "[asset-reference]: ./assets/architecture.png",
      "[shortcut reference]: ./guide/README.md#install",
      "[collapsed reference]: ./guide/README.md#install",
      "[unused-definition]: ./missing-definition.md",
      "",
      "\\[Escaped](also-missing.md)",
      `${tick}[Inline code](inline-missing.md)${tick}`,
      "",
      `${tick.repeat(3)}md`,
      "[Fenced code](fenced-missing.md)",
      tick.repeat(3),
      ""
    ].join("\n");
    await writeFile(readmePath, source, "utf8");
    await writeFile(
      join(root, "docs", "guide", "space file.md"),
      "# Café\n",
      "utf8"
    );

    const observation = await new FilesystemMarkdownRepository().observe({
      consumerRoot: root,
      roots: ["docs"]
    });
    const document = observation.documents.find(
      (candidate) => candidate.repositoryPath === "docs/README.md"
    );
    assert.ok(document !== undefined);
    assert.equal(document.frontmatter.kind, "valid");
    if (document.frontmatter.kind !== "valid") {
      return;
    }
    assert.deepEqual(document.frontmatter.value, { title: "Markdown AST coverage" });
    assert.deepEqual(
      document.headings.map((heading) => heading.text),
      ["C++ & C#", "C++ & C#", "API guide with code"]
    );
    assert.deepEqual(anchorsForMarkdownDocument(document, "github"), [
      "c--c",
      "c--c-1",
      "api-guide-with-code"
    ]);
    assert.deepEqual(
      document.references.map((reference) => ({
        kind: reference.kind,
        rawTarget: reference.rawTarget
      })),
      [
        { kind: "link", rawTarget: "./guide/README.md#install-1" },
        { kind: "image", rawTarget: "./assets/architecture.png" },
        { kind: "link", rawTarget: "guide/space%20file.md#caf%C3%A9" },
        { kind: "link", rawTarget: "./guide/README.md#install" },
        { kind: "link", rawTarget: "./guide/README.md#install" },
        { kind: "link", rawTarget: "guide/README.md#install" },
        { kind: "link", rawTarget: "guide/README.md#install-1" },
        { kind: "definition", rawTarget: "./missing-definition.md" }
      ]
    );
    assert.deepEqual(document.references[0]?.location, {
      column: 1,
      line: 9,
      offset: source.indexOf("[Reference usage]")
    });
    assert.deepEqual(ruleIds(await analyze(root)), [
      "documentation.local-references.broken-link"
    ]);
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

test("rejects link path casing that would fail on a case-sensitive checkout", async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, "docs", "README.md"),
      "# Documentation\n\n[Wrong case](Guide/README.md)\n",
      "utf8"
    );
    assert.deepEqual(ruleIds(await analyze(root)), [
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

test("configuration adapter consumes only its explicit YAML and schema dependencies", async () => {
  const input = { schemaVersion: 1, markdownRoots: ["notes", "docs"], anchorProfile: "github" };
  const signal = new AbortController().signal;
  const calls = [];
  const policy = await loadWithDependencies({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async assertSchema(...args) { calls.push(["schema", ...args]); }
  }, "explicit-memory-consumer", "policy.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "policy.yaml", "documentation-local-references-config", signal],
    ["schema", "documentation-local-references/v1", input, "documentation-local-references-config"]
  ]);
  assert.deepEqual(policy, { anchorProfile: "github", markdownRoots: ["docs", "notes"] });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.markdownRoots));
  assert.deepEqual(input.markdownRoots, ["notes", "docs"]);
});

test("configuration adapter preserves schema rejection before normalizing input", async () => {
  const failure = new Error("explicit schema rejection");
  let observed = 0;
  await assert.rejects(loadWithDependencies({
    async readYaml() { return null; },
    async assertSchema(id, input, phase) {
      assert.equal(id, "documentation-local-references/v1");
      assert.equal(input, null);
      assert.equal(phase, "documentation-local-references-config");
      observed += 1;
      throw failure;
    }
  }, "explicit-memory-consumer", "policy.yaml"), (error) => error === failure);
  assert.equal(observed, 1);
});

test("documentation configuration no longer joins the module schema assembly cycle", async () => {
  const graph = await observeFoundationFeatureGraph();
  assert.deepEqual(graph.missing, []);
  for (const cycle of [...graph.runtimeCycles, ...graph.combinedCycles]) {
    assert.equal(cycle.includes("documentation-local-references"), false, JSON.stringify(cycle));
  }
});

test("source policy rejects reintroducing schema assembly inside the documentation adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "documentation-schema-boundary-"));
  try {
    await copySourcePolicyFixture(root);
    const path = "packages/engineering-foundation/src/capabilities/documentation-local-references/adapters/inbound/configuration/load-capability-config.ts";
    const source = await readFile(join(root, path), "utf8");
    await writeFile(join(root, path), `${source}\nexport { assertSchema as ModuleSchemaLeak } from "../../../../../schema-catalog.js";\n`);
    const result = actualSourceDependenciesCLI(root);
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.ok(result.report.capabilities.flatMap((capability) => capability.diagnostics).some((diagnostic) =>
      diagnostic.ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" && diagnostic.location.path === path
    ), JSON.stringify(result.report));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

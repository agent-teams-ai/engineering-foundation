import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const packageRoot = new URL("..", import.meta.url).pathname;
const packagesRoot = new URL("../..", import.meta.url).pathname;

const targetEdges = new Map([
  ["repository-mutation", []],
  ["document-authoring", ["@agent-teams/repository-mutation"]],
  ["engineering-foundation", [
    "@agent-teams/document-authoring",
    "@agent-teams/repository-mutation"
  ]],
  ["docs-protocol", [
    "@agent-teams/document-authoring",
    "@agent-teams/repository-mutation"
  ]],
  ["docs-protocol-agent-teams", [
    "@agent-teams/docs-protocol",
    "@agent-teams/repository-mutation"
  ]],
  ["docs-protocol-mcp", ["@agent-teams/docs-protocol"]]
]);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

test("physical package has the closed Repository Mutation edge", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.dependencies).filter((name) => name.startsWith("@agent-teams/")).toSorted(),
    ["@agent-teams/repository-mutation"]
  );
  assert.equal(manifest.exports["./document-authoring"], undefined);
  const source = (await Promise.all(
    (await sourceFiles(join(packageRoot, "src"))).map((path) => readFile(path, "utf8"))
  )).join("\n");
  assert.doesNotMatch(source, /from\s+["']@agent-teams\/engineering-foundation/u);
  assert.doesNotMatch(source, /import\s*\(\s*["'`]@agent-teams\/engineering-foundation/u);
});

test("portable package manifests and source imports implement the closed target DAG", async () => {
  for (const [directory, expectedDependencies] of targetEdges) {
    const root = join(packagesRoot, directory);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const declared = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies
    };
    assert.deepEqual(
      Object.keys(declared)
        .filter((name) => name.startsWith("@agent-teams/"))
        .toSorted(),
      expectedDependencies
    );

    const imports = new Set();
    for (const path of await sourceFiles(join(root, "src"))) {
      const source = await readFile(path, "utf8");
      const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](@agent-teams\/[a-z0-9-]+(?:\/[a-z0-9-]+)?)["']/gu;
      for (const match of source.matchAll(pattern)) {
        imports.add(match[1]);
      }
    }
    const importedPackages = [...imports]
      .map((specifier) => specifier.split("/").slice(0, 2).join("/"))
      .toSorted();
    assert.deepEqual([...new Set(importedPackages)], expectedDependencies);
    if (directory === "docs-protocol-mcp") {
      assert.deepEqual([...imports], ["@agent-teams/docs-protocol"]);
    }
  }
});

test("new plans identify Document Authoring while schemas retain admitted legacy evidence", async () => {
  const source = await readFile(join(packageRoot, "src/composition/node-document-planning.ts"), "utf8");
  assert.match(source, /id: "@agent-teams\/document-authoring"/u);
  const plan = JSON.parse(await readFile(
    join(packageRoot, "schemas/document-plan/v1.schema.json"), "utf8"
  ));
  assert.deepEqual(plan.$defs.compiler.properties.id.enum, [
    "@agent-teams/document-authoring",
    "@agent-teams/engineering-foundation"
  ]);
});

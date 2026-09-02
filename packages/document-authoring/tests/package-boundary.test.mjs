import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const packageRoot = new URL("..", import.meta.url).pathname;

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

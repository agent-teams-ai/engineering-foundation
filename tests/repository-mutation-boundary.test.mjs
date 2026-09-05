import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sourceFiles } from "./package-boundary-support.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repositoryRoot, "packages", "repository-mutation");

async function filesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {files.push(...await filesBelow(path));}
    else if (entry.isFile()) {files.push(path);}
  }
  return files;
}

test("keeps Repository Mutation a zero-monorepo-dependency packed closure", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@agent-teams/repository-mutation");
  assert.match(manifest.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.exports).toSorted(), [
    ".", "./node", "./package.json", "./qualification", "./schemas/*"
  ]);

  const files = (await filesBelow(packageRoot)).filter((path) =>
    /(?:src|dist|schemas)[/\\]/u.test(relative(packageRoot, path)));
  assert.ok(files.length > 0);
  for (const path of files) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /@agent-teams\/(?:engineering-foundation|docs-protocol)/u,
      relative(repositoryRoot, path));
  }
});

test("production and generic directory adapters share the internal bind kernel", async () => {
  const productionPath = (await sourceFiles(join(
    repositoryRoot,
    "packages/document-authoring/src",
  ))).find((path) => basename(path) === "node-document-parent-materializer.ts");
  assert.notEqual(productionPath, undefined);
  const production = await readFile(productionPath, "utf8");
  const generic = await readFile(join(
    repositoryRoot,
    "packages/repository-mutation/src/repository-mutation/adapters/node/node-directory-materialization.ts",
  ), "utf8");
  assert.match(production, /@agent-teams\/repository-mutation\/node/iu); assert.match(generic, /node-create-and-bind-directory\.js/iu);
  for (const source of [production, generic]) {
    assert.match(source, /createAndBindNodeDirectory\s*\(/u);
  }
  const publicMutationBarrel = await readFile(join(
    repositoryRoot,
    "packages/repository-mutation/src/index.ts",
  ), "utf8");
  assert.doesNotMatch(publicMutationBarrel, /createAndBindNodeDirectory/u);
});

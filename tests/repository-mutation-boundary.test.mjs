import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
  assert.equal(manifest.version, "0.0.0");
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.exports).toSorted(), [
    ".", "./package.json", "./qualification", "./schemas/*"
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

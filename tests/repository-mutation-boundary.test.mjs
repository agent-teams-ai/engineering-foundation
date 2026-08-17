import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(repositoryRoot, "packages", "engineering-foundation", "src", "repository-mutation");
const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "packages", "engineering-foundation", "package.json"), "utf8"));

async function sourceFilesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFilesBelow(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

test("keeps repository mutation private and vocabulary-neutral", async () => {
  const files = await sourceFilesBelow(sourceRoot);
  assert.ok(files.length > 0);
  assert.equal(files.some((path) => /(?:^|[/\\])index\.ts$/iu.test(path)), false);
  for (const path of files) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(`${relative(repositoryRoot, path)}\n${source}`, /scaffold|document|target|recipe/iu);
  }
  assert.equal(Object.hasOwn(packageManifest.exports, "./repository-mutation"), false);
  assert.equal(Object.keys(packageManifest.exports).some((key) => key.includes("repository-mutation")), false);
});

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");

async function filesBelow(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...await filesBelow(path));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

test("ships one current Foundation-owned v1 contract identity", async () => {
  const schemaRoot = join(packageRoot, "schemas");
  const schemaFiles = (await filesBelow(schemaRoot)).filter((path) =>
    path.endsWith(".schema.json"),
  );
  const forbiddenSchemaPaths = schemaFiles
    .map((path) => relative(packageRoot, path))
    .filter((path) => /\/v(?:[2-9]|[1-9][0-9]+)\.schema\.json$/u.test(path));
  assert.deepEqual(forbiddenSchemaPaths, []);

  for (const path of schemaFiles) {
    const schema = JSON.parse(await readFile(path, "utf8"));
    if (typeof schema.$id === "string") {
      assert.doesNotMatch(
        schema.$id,
        /\/(?:v[2-9]|v[1-9][0-9]+)$/u,
        `Foundation-owned schema has a parallel current version: ${relative(packageRoot, path)}`,
      );
    }
  }

  const sourceFiles = (await filesBelow(join(packageRoot, "src"))).filter((path) =>
    path.endsWith(".ts"),
  );
  const forbiddenContractLiterals =
    /(?:schemaVersion|protocolVersion|producerVersion):\s*2\b/u;
  for (const path of sourceFiles) {
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      forbiddenContractLiterals,
      `Current source declares a Foundation-owned v2 contract: ${relative(packageRoot, path)}`,
    );
  }

  const packageManifest = await readFile(join(packageRoot, "package.json"), "utf8");
  assert.doesNotMatch(packageManifest, /\/v2\.schema\.json/u);
});

test("keeps upstream Buf v2 distinct from Foundation contract versions", async () => {
  const source = await readFile(
    join(
      packageRoot,
      "src",
      "capabilities",
      "contract-protobuf-evolution",
      "application",
      "model",
      "buf-breaking-qualification.ts",
    ),
    "utf8",
  );
  assert.equal(source.includes('{"version":"v2"'), true);

  const decision = await readFile(
    join(repositoryRoot, "docs", "decisions", "0019-single-current-foundation-contract-version.md"),
    "utf8",
  );
  assert.match(decision, /Buf config `version: v2`/u);
  assert.match(decision, /outside this rule/u);
});

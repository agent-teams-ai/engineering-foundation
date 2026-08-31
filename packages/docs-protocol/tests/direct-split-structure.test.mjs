import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const packageRoot = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...await files(path));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}

test("portable tarball projection contains no managed integration authority", async () => {
  assert.deepEqual(manifest.bin, {
    "agent-teams-docs": "./dist/cli.js",
    "docs-protocol": "./dist/cli.js"
  });
  assert.equal(manifest.dependencies?.["@agent-teams/docs-protocol-agent-teams"], undefined);
  const packedEntries = JSON.stringify(manifest.files);
  assert.doesNotMatch(packedEntries, /consumer|cohort|managed-state|qualification-receipt|assets|skills/u);

  const sources = await files(join(packageRoot, "src"));
  const combined = (await Promise.all(sources.map((path) => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(combined, /consumerIntegration|QualifiedDocsCohort|agent-teams-managed-v1|docs\.qualify|runDocsProtocolQualificationV2/u);
  assert.doesNotMatch(combined, /import\s*\(\s*[`'"]@agent-teams\/docs-protocol-agent-teams|require\s*\(\s*[`'"]@agent-teams\/docs-protocol-agent-teams/u);
});

test("portable command schemas reject managed commands structurally", async () => {
  for (const version of [1, 2, 3]) {
    const schema = JSON.parse(await readFile(join(
      packageRoot,
      "schemas",
      "docs-protocol-portable-command-envelope",
      `v${version}.schema.json`
    ), "utf8"));
    assert.equal(schema.properties.command.enum.includes("docs.qualify"), false);
  }
});

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { planScaffoldFromFile } from "../packages/engineering-foundation/dist/scaffolding/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-consumer"
);

async function plan(consumerRoot) {
  return planScaffoldFromFile({
    consumerRoot,
    intentPath: "intents/facets-forward.yaml"
  });
}

test("produces the same Plan for LF and CRLF authority files", async () => {
  const crlfRoot = await mkdtemp(join(tmpdir(), "foundation-scaffolding-crlf-"));
  await cp(fixtureRoot, crlfRoot, { recursive: true });
  try {
    for (const repositoryPath of [
      "architecture/foundation/scaffolding.yaml",
      "architecture/package-catalog.yaml"
    ]) {
      const path = join(crlfRoot, ...repositoryPath.split("/"));
      const source = await readFile(path, "utf8");
      await writeFile(path, source.replace(/\r?\n/gu, "\r\n"), "utf8");
    }
    assert.deepEqual(await plan(crlfRoot), await plan(fixtureRoot));
  } finally {
    await rm(crlfRoot, { recursive: true, force: true });
  }
});

test("bounds operation IDs independently of valid output path length", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-long-path-"));
  await cp(fixtureRoot, root, { recursive: true });
  try {
    const catalogPath = join(root, "architecture", "package-catalog.yaml");
    const longTarget = `packages/${"a".repeat(200)}/generated`;
    await writeFile(
      catalogPath,
      (await readFile(catalogPath, "utf8")).replace(
        "packages/testing/generated",
        longTarget
      ),
      "utf8"
    );
    const scaffoldPlan = await plan(root);
    assert.ok(scaffoldPlan.operations.every(({ id }) => id.length <= 214));
    assert.ok(
      scaffoldPlan.operations.every(({ path }) => path.startsWith(`${longTarget}/`))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

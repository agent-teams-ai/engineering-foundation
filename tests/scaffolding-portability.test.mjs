import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyFilesystemScaffold,
  MemoryScaffoldWorkspace,
  planScaffoldFromFile
} from "../packages/engineering-foundation/dist/scaffolding/internal-rendering-regression-api.js";
import { loadScaffoldCompilationInput } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-input-loader.js";
import { CONFORMANCE_FIXTURE_DEFINITIONS } from "../packages/engineering-foundation/dist/scaffolding/definitions/conformance-fixture.js";
import { compileScaffoldPlan } from "../packages/engineering-foundation/dist/scaffolding/kernel/rendering-plan-compiler.js";
import { ScaffoldDefinitionRegistry } from "../packages/engineering-foundation/dist/scaffolding/kernel/definition-registry.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

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

test("reports a deleted authority file as a stale snapshot", async () => {
  for (const authorityPath of [
    "architecture/package-catalog.yaml",
    "architecture/foundation/scaffolding.yaml"
  ]) {
    const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-stale-"));
    await cp(fixtureRoot, root, { recursive: true });
    try {
      const scaffoldPlan = await plan(root);
      await rm(join(root, ...authorityPath.split("/")));
      const receipt = await applyFilesystemScaffold(root, scaffoldPlan);
      assert.equal(receipt.outcome, "rejected", authorityPath);
      assert.equal(
        receipt.diagnostics[0]?.ruleId,
        "scaffolding.apply.stale-authority-snapshot",
        authorityPath
      );
      await assert.rejects(
        stat(join(root, ...scaffoldPlan.operations[0].path.split("/"))),
        /ENOENT/u,
        authorityPath
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

test("rejects non-normalized target catalog paths", async () => {
  for (const targetPath of [
    "packages/testing/generated/",
    "packages//testing/generated"
  ]) {
    const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-path-"));
    await cp(fixtureRoot, root, { recursive: true });
    try {
      const catalogPath = join(root, "architecture", "package-catalog.yaml");
      await writeFile(
        catalogPath,
        (await readFile(catalogPath, "utf8")).replace(
          "packages/testing/generated",
          targetPath
        ),
        "utf8"
      );
      await assert.rejects(plan(root), /must match pattern/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects a non-normalized target in programmatic compiler input", async () => {
  const input = structuredClone(
    await loadScaffoldCompilationInput({
      consumerRoot: fixtureRoot,
      configPath: "architecture/foundation/scaffolding.yaml",
      intentPath: "intents/facets-forward.yaml",
      foundationVersion: "0.1.1"
    })
  );
  input.catalog.packages[0].path = `${input.catalog.packages[0].path}/`;
  assert.throws(
    () =>
      compileScaffoldPlan(
        input,
        new ScaffoldDefinitionRegistry(CONFORMANCE_FIXTURE_DEFINITIONS)
      ),
    /Target path must be normalized/u
  );
});

test("rejects non-normalized receipt operation paths", async () => {
  const receipt = await new MemoryScaffoldWorkspace().apply(await plan(fixtureRoot));
  await assertSchema("scaffold-receipt/v1", receipt, "scaffold-receipt");

  const invalidReceipt = structuredClone(receipt);
  const operation = invalidReceipt.operations[0];
  assert.ok(operation);
  operation.path = `${operation.path}/`;
  await assert.rejects(
    assertSchema("scaffold-receipt/v1", invalidReceipt, "scaffold-receipt"),
    /must match pattern/u
  );
});

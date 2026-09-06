import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actualSourceDependenciesCLI, copySourcePolicyFixture, observeFoundationFeatureGraph } from "./local-mode-boundaries.mjs";

export async function assertFeatureOutsideSchemaCycles(featureId) {
  const graph = await observeFoundationFeatureGraph();
  assert.deepEqual(graph.missing, []);
  for (const cycle of [...graph.runtimeCycles, ...graph.combinedCycles]) {
    assert.equal(cycle.includes(featureId), false, JSON.stringify(cycle));
  }
}

export async function assertSchemaAssemblyImportRejected(path, specifier) {
  return assertSchemaAssemblyImportsRejected([{ path, specifier }]);
}

export async function assertSchemaAssemblyImportsRejected(imports) {
  assert.ok(imports.length > 0);
  const root = await mkdtemp(join(tmpdir(), "schema-adapter-boundary-"));
  try {
    await copySourcePolicyFixture(root);
    for (const { path, specifier } of imports) {
      const source = await readFile(join(root, path), "utf8");
      await writeFile(join(root, path), `${source}\nexport { assertSchema as ModuleSchemaLeak } from ${JSON.stringify(specifier)};\n`);
    }
    const result = actualSourceDependenciesCLI(root);
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    const diagnostics = result.report.capabilities.flatMap((capability) => capability.diagnostics);
    for (const { path } of imports) {
      assert.ok(diagnostics.some((diagnostic) =>
        diagnostic.ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" && diagnostic.location.path === path
      ), JSON.stringify(result.report));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

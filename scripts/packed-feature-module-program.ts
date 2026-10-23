export const featureModuleProgram = `
  import assert from "node:assert/strict";
  import { mkdir, readFile, writeFile } from "node:fs/promises";
  import { createRequire } from "node:module";
  import { dirname, join } from "node:path";
  import { fileURLToPath } from "node:url";
  import { checkFeatureModule, STANDARD } from "@agent-teams/feature-module-standard";
  import { exampleModule, exampleSources } from "@agent-teams/feature-module-standard/fixtures";
  import { checkFeatureModuleOnDisk, formatNodeReport } from "@agent-teams/feature-module-standard/node";
  const foundationResolution = import.meta.resolve("@agent-teams/engineering-foundation/package.json");
  const foundationManifest = JSON.parse(await readFile(fileURLToPath(foundationResolution), "utf8"));
  assert.equal(foundationManifest.name, "@agent-teams/engineering-foundation");
  assert.equal(foundationManifest.version, process.argv[2]);
  const standardManifest = JSON.parse(await readFile(fileURLToPath(import.meta.resolve("@agent-teams/feature-module-standard/package.json")), "utf8"));
  assert.equal(standardManifest.peerDependencies["@agent-teams/engineering-foundation"], "^1.8.0 || ^2.0.0 || ^3.0.0");
  assert.equal(standardManifest.peerDependenciesMeta["@agent-teams/engineering-foundation"].optional, true);
  const fromFms = createRequire(import.meta.resolve("@agent-teams/feature-module-standard/node"));
  assert.equal(fromFms.resolve("@agent-teams/engineering-foundation/package.json"), fileURLToPath(foundationResolution));
  const expected = exampleModule();
  const consumerRoot = join(process.cwd(), "subject");
  for (const [path, source] of Object.entries(exampleSources())) {
    await mkdir(dirname(join(consumerRoot, path)), { recursive: true });
    await writeFile(join(consumerRoot, path), source);
  }
  const { files, imports, emptyDirectories, ...profile } = expected;
  assert.ok(files.length > 0 && imports.length > 0);
  const config = { consumerRoot, sourceRoots: ["src"], structure: {
    featureRoots: profile.featureRoots, roleRoots: profile.roleRoots, featuresRoots: profile.featuresRoots,
  }, surfaces: profile.surfaces, moduleComposition: profile.moduleComposition };
  const report = await checkFeatureModuleOnDisk(config);
  const pure = checkFeatureModule(expected);
  assert.equal(report.ok, true);
  assert.deepEqual(report.diagnostics, pure.diagnostics);
  assert.deepEqual(report.metrics, pure.metrics);
  const budget = await checkFeatureModuleOnDisk({ ...config, budgets: [{ metric: "sourceFiles", max: 0 }] });
  assert.equal(budget.ok, true);
  assert.deepEqual(budget.diagnostics, []);
  assert.deepEqual(budget.budgetWarnings, pure.metrics.filter(item => item.sourceFiles > 0)
    .map(item => ({ subject: item.id, metric: "sourceFiles", value: item.sourceFiles, max: 0 }))
    .toSorted((left, right) => left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0));
  assert.match(formatNodeReport(budget), /^warning budget /mu);
  const unlisted = await checkFeatureModuleOnDisk({ ...config, moduleComposition: [] });
  assert.equal(unlisted.ok, false);
  assert.ok(unlisted.diagnostics.some(item => item.code === "deep-import"));
  const path = "src/features/orders/contracts/public.ts";
  for (const syntax of ["export *", "export type *"]) {
    await writeFile(join(consumerRoot, path), syntax + " from '../features/pricing/contracts/public.ts';\\n");
    const rejected = await checkFeatureModuleOnDisk(config);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.diagnostics.map(item => item.code), ["republication-undeclared"]);
  }
  await writeFile(join(consumerRoot, path), exampleSources()[path]);
  const unresolvedPath = "src/features/orders/application/use-case.ts";
  for (const source of ['import "./missing.js";', 'import "#hidden/domain";', 'const target = "./missing.js"; void import(target);']) {
    await writeFile(join(consumerRoot, unresolvedPath), source);
    const rejected = await checkFeatureModuleOnDisk(config);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.unresolved.length + rejected.unresolvedRuntimeReferences.length, 1);
  }
  await writeFile(join(consumerRoot, unresolvedPath), exampleSources()[unresolvedPath]);
  const malformedPath = "src/features/billing/domain/model.ts";
  await writeFile(join(consumerRoot, malformedPath), 'import { from ;\\n');
  const malformed = await checkFeatureModuleOnDisk(config);
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.parseFailures, [malformedPath]);
  assert.deepEqual(malformed.unresolved, []);
  assert.deepEqual(malformed.unresolvedRuntimeReferences, []);
  await writeFile(join(consumerRoot, malformedPath), exampleSources()[malformedPath]);
  const restored = await checkFeatureModuleOnDisk(config);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.parseFailures, []);
  await assert.rejects(import("@agent-teams/feature-module-standard/dist/node.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  for (const suffix of ["", "/fixtures", "/node"]) {
    assert.ok(fileURLToPath(import.meta.resolve("@agent-teams/feature-module-standard" + suffix)).startsWith(process.cwd()));
  }
  assert.equal(STANDARD.version, "v1.1");
  console.log(JSON.stringify({ status: "passed", cases: ["public-typed-entries", "actual-source-parity",
    "explicit-module-composition", "runtime-republication", "type-only-republication", "closed-deep-import",
    "missing-relative-reference", "unsupported-literal-reference", "computed-reference", "malformed-source", "budget-warning"],
    foundationVersion: foundationManifest.version, foundationResolution, standard: STANDARD }));
  `;

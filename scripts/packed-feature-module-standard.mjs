import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Uses the caller's already qualified archives. No build or pack occurs here.
export async function verifyPackedFeatureModuleStandard({
  artifacts, temporaryRoot, packageManager, typescript, runPnpm,
}) {
  const directory = join(temporaryRoot, "feature-module-standard-consumer");
  const name = "@agent-teams/feature-module-standard";
  const artifact = artifacts[name];
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "feature-module-standard-packed-TEST", private: true, type: "module", packageManager,
    devDependencies: { [name]: artifact.archiveFileSpecifier,
      "@agent-teams/engineering-foundation": artifacts["@agent-teams/engineering-foundation"].archiveFileSpecifier,
      typescript },
  }, null, 2)}\n`);
  await writeFile(join(directory, "pnpm-workspace.yaml"), `overrides:\n${
    ["engineering-foundation", "repository-mutation", "document-authoring"].map(localName =>
      `  "@agent-teams/${localName}": ${JSON.stringify(artifacts[`@agent-teams/${localName}`].archiveFileSpecifier)}`).join("\n")
  }\n`);
  await runPnpm(["install", "--ignore-scripts", "--strict-peer-dependencies"], directory);
  await writeFile(join(directory, "check.ts"), `
import { checkFeatureModule, STANDARD } from "@agent-teams/feature-module-standard";
import { exampleModule, exampleSources } from "@agent-teams/feature-module-standard/fixtures";
import { checkFeatureModuleOnDisk, formatNodeReport } from "@agent-teams/feature-module-standard/node";
import type { NodeCheckConfig, NodeReport } from "@agent-teams/feature-module-standard/node";
const config: NodeCheckConfig = { consumerRoot: ".", sourceRoots: ["src"],
  structure: { featureRoots: [], roleRoots: [] }, moduleComposition: [] };
const pending: Promise<NodeReport> = checkFeatureModuleOnDisk(config);
void pending.then(report => formatNodeReport(report));
void checkFeatureModule(exampleModule()); void exampleSources(); void STANDARD;
`);
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, skipLibCheck: false, noEmit: true, types: [] }, files: ["check.ts"],
  }));
  await runPnpm(["exec", "tsc", "--project", "tsconfig.json"], directory);
  await writeFile(join(directory, "check.mjs"), `
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFeatureModule, STANDARD } from "@agent-teams/feature-module-standard";
import { exampleModule, exampleSources } from "@agent-teams/feature-module-standard/fixtures";
import { checkFeatureModuleOnDisk } from "@agent-teams/feature-module-standard/node";
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
const unresolvedPath = "src/features/orders/application/service.ts";
for (const source of ['import "./missing.js";', 'import "#hidden/domain";', 'const target = "./missing.js"; void import(target);']) {
  await writeFile(join(consumerRoot, unresolvedPath), source);
  const rejected = await checkFeatureModuleOnDisk(config);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.unresolved.length + rejected.unresolvedRuntimeReferences.length, 1);
}
await assert.rejects(import("@agent-teams/feature-module-standard/dist/node.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
for (const suffix of ["", "/fixtures", "/node"]) {
  assert.ok(fileURLToPath(import.meta.resolve("@agent-teams/feature-module-standard" + suffix)).startsWith(process.cwd()));
}
assert.equal(STANDARD.version, "v1.1");
console.log(JSON.stringify({ status: "passed", cases: ["public-typed-entries", "actual-source-parity",
  "explicit-module-composition", "runtime-republication", "type-only-republication", "closed-deep-import",
  "missing-relative-reference", "unsupported-literal-reference", "computed-reference"], standard: STANDARD }));
`);
  const runtime = await runPnpm(["exec", "node", "check.mjs"], directory);
  const report = JSON.parse(runtime.stdout);
  if (report.status !== "passed" || report.cases.length !== 9) {
    throw new Error("Packed Feature Module Standard did not complete its public source checks.");
  }
  const evidence = { ...report, packageName: artifact.packageName, packageVersion: artifact.packageVersion,
    archiveSha256: createHash("sha256").update(await readFile(artifact.archivePath)).digest("hex"), typescript,
    lockfileSha256: createHash("sha256").update(await readFile(join(directory, "pnpm-lock.yaml"))).digest("hex") };
  process.stdout.write(`Packed Feature Module Standard conformance PASS: ${JSON.stringify(evidence)}\n`);
  return evidence;
}

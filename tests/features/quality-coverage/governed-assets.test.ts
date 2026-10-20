import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createQualityCoverageReader, createQualityConfigurationReader } from "../../../packages/engineering-foundation/dist/features/quality-coverage/node.js";
import { assetValidatorDeclaration, checkStaticQualityCoverage, executesAssetValidator } from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import { mapQualityProfile } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/profile-input.js";
import { createSourceCensusReader } from "../../../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { loadStrictYamlFile } from "../../../packages/engineering-foundation/dist/features/configuration-input/node.js";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";
import { assertSchema } from "../../../packages/engineering-foundation/dist/schema-catalog.js";
import { cleanupIdentityMatchingOwnedTemporary, inspectRetiredTemporaryDuplicates, readBoundedRegularFile, syncDirectoryDurably } from "../../../packages/repository-mutation/dist/node.js";

const moduleRoot = "packages/example";
const sourceRoot = `${moduleRoot}/src`;
const main = `${sourceRoot}/main.ts`;
const proto = `${sourceRoot}/contracts/example.proto`;
const sql = `${sourceRoot}/adapters/migrations/0001.sql`;
const asset = (path: string, kind: string, script: string) => ({ path, kind, script, boundaryId: "example" });
const profile = {
  schemaVersion: 3, sourcePolicyPath: "source.yaml", suppressionPolicyPath: "suppressions.yaml",
  featureProfilePath: "features.json", lintConfigPath: "lint.json", compilerProjects: ["config/production.json"],
  scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" },
  assets: [asset(proto, "protobuf", "wire:check"), asset(sql, "sql-migration", "migration:check")]
};
const scripts = {
  "check:fast": "pnpm quality:scope", check: "pnpm lint:typed && pnpm wire:check && pnpm migration:check",
  "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
  "lint:typed": "agent-teams-foundation quality check --consumer .",
  "wire:check": "tsc --project scripts/wire/tsconfig.json --noEmit && node scripts/wire/generate.ts --check && buf build && buf lint && buf format --diff --exit-code",
  "migration:check": "node scripts/check-migrations.ts"
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "TEST-quality-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path: string, bytes: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  };
  await put(`${moduleRoot}/package.json`, '{"name":"fixture-example","private":true}');
  await put(main, "export const value = 1;\n");
  await put(proto, 'syntax = "proto3"; message Example {}\n');
  await put(sql, "CREATE TABLE example (id integer PRIMARY KEY);\n");
  await put("config/production.json", "{}");
  await put("scripts/wire/generate.ts", "throw new Error('static checks never execute validators');\n");
  await put("scripts/check-migrations.ts", "throw new Error('native migration qualification belongs to the consumer');\n");
  await put("quality.yaml", JSON.stringify(profile));
  await put("package.json", JSON.stringify({ scripts }));
  await put("features.json", JSON.stringify({ schemaVersion: 1,
    standard: { id: "agent-teams.feature-module-standard", version: "v1" },
    productionRoots: ["packages"], applicationRoots: [], excludedRoots: [],
    topology: { sourcePolicy: "source.yaml" },
    modules: [{ root: moduleRoot, sourceRoot, testRoots: [`${moduleRoot}/tests`] }]
  }));
  const typed = JSON.parse(await readFile(new URL("../../../packages/engineering-foundation/presets/oxlint/type-aware.json", import.meta.url), "utf8"));
  const budgets = JSON.parse(await readFile(new URL("../../../packages/engineering-foundation/presets/oxlint/maintainability.json", import.meta.url), "utf8"));
  await put("lint.json", JSON.stringify({ options: { ...typed.options, respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" }, rules: { ...typed.rules, ...budgets.rules } }));
  const reader = createQualityCoverageReader({
    census: createSourceCensusReader({ read: readContainedRegularFile }),
    inventory: { read: async () => ({ packages: [], catalogs: [] }) },
    authority: {
      source: async () => ({ workspaceManifestPath: "pnpm-workspace.yaml", boundaries: [{ id: "example", roots: [sourceRoot] }] }),
      suppressions: async () => ({ governedRoots: [sourceRoot] })
    }
  }, createQualityConfigurationReader(loadStrictYamlFile, assertSchema), readContainedRegularFile);
  const run = () => checkStaticQualityCoverage({ consumerRoot: root, configPath: "quality.yaml" }, reader);
  return { root, put, reader, run };
}

test("v3 assets preserve exact semantic ownership and require reachable readable validators", async (t) => {
  const { put, reader, root, run } = await fixture(t);
  assert.equal((await run()).outcome, "passed");
  const observation = await reader.read(root, "quality.yaml");
  assert.deepEqual(observation.sources.filter(({ assetGates }) => assetGates !== undefined).map(({ path, owners, suppressionCovered }) => ({ path, owners, suppressionCovered })),
    [sql, proto].toSorted().map((path) => ({ path, owners: ["example"], suppressionCovered: true })));
  for (const command of ["true", "false && node scripts/check-migrations.ts", "node scripts/check-migrations.ts || true"]) {
    await put("package.json", JSON.stringify({ scripts: { ...scripts, "migration:check": command } }));
    assert.ok((await run()).diagnostics.some(({ ruleId, location }) => ruleId === "quality.source-coverage.asset-route" && location.path === sql));
  }
  await put("package.json", JSON.stringify({ scripts: { ...scripts, check: "pnpm lint:typed && pnpm wire:check" } }));
  assert.equal((await run()).outcome, "violations");
  await put("package.json", JSON.stringify({ scripts }));
  await rm(join(root, "scripts/check-migrations.ts"));
  const missing = await run();
  assert.equal(missing.outcome, "invalid-input");
  assert.equal(missing.problem?.code, "QUALITY_PROFILE_INVALID");
  assert.match(missing.problem?.message ?? "", /Asset validator script.*migration:check/u);
  assert.deepEqual(missing.diagnostics, []);
  await mkdir(join(root, "scripts/check-migrations.ts"));
  const unreadable = await run();
  assert.equal(unreadable.outcome, "invalid-input", "a directory cannot qualify as a readable validator file");
  assert.equal(unreadable.problem?.code, "QUALITY_PROFILE_INVALID");
});

test("assets cannot admit executable extensions, unknown siblings, stale paths or another owner", async (t) => {
  const { root, put, run } = await fixture(t);
  for (const assets of [
    [asset(main, "protobuf", "wire:check")],
    [asset(proto, "javascript", "wire:check")],
    [asset(`${sourceRoot}/**/*.proto`, "protobuf", "wire:check")],
    [asset(`${sourceRoot}/missing.proto`, "protobuf", "wire:check")],
    [{ ...profile.assets[0], boundaryId: "other" }],
    [profile.assets[0], profile.assets[0]]
  ]) {
    await put("quality.yaml", JSON.stringify({ ...profile, assets }));
    assert.equal((await run()).outcome, "invalid-input");
  }
  await put("quality.yaml", JSON.stringify(profile));
  for (const name of ["renamed.sql", "nested/unknown.future", "hidden.js"]) {
    const path = `${sourceRoot}/${name}`;
    await put(path, "export const executable = 1;\n");
    assert.ok((await run()).diagnostics.some(({ location }) => location.path === path), path);
    await rm(join(root, path));
  }
  await rename(join(root, proto), join(root, `${proto}.ts`));
  assert.equal((await run()).outcome, "invalid-input", "renaming an admitted path cannot transfer its asset status");
});

test("v1/v2 cannot opt into v3 asset fields and fixed kind must match extension", async () => {
  for (const schemaVersion of [1, 2] as const) {
    await assert.rejects(assertSchema(`quality-source-coverage/v${schemaVersion}`, { ...profile, schemaVersion }, "test"));
  }
  await assertSchema("quality-source-coverage/v3", profile, "test");
  assert.throws(() => mapQualityProfile({ ...profile, assets: [asset(sql, "protobuf", "wire:check")] }), /fixed protobuf or sql-migration/u);
});

test("asset route observations reject cycles, no-ops, masks and absent targets", () => {
  assert.equal(executesAssetValidator(scripts, "check", "wire:check"), true);
  assert.deepEqual(assetValidatorDeclaration(scripts["wire:check"]), ["scripts/wire/generate.ts"]);
  for (const command of ["true", "echo validator", "node ../escape.ts", "node scripts/check.ts ; true", "buf lint || true", "node scripts/check.ts\ntrue"]) {
    assert.equal(executesAssetValidator({ ...scripts, "wire:check": command }, "check", "wire:check"), false, command);
  }
  assert.equal(executesAssetValidator({ check: "pnpm cycle", cycle: "pnpm check" }, "check", "wire:check"), false);
});

async function retiredFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "TEST-retired-duplicates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "src");
  await mkdir(parent);
  const temporaryPath = join(parent, ".index.ts.temporary");
  const counterpart = "src/index.ts";
  await writeFile(temporaryPath, "export const guarded = true;\n");
  await link(temporaryPath, join(root, counterpart));
  const observed = await readBoundedRegularFile(temporaryPath, 1024);
  assert.equal(observed.outcome, "read");
  if (observed.outcome !== "read") { throw new Error("missing owned fixture"); }
  assert.equal(await cleanupIdentityMatchingOwnedTemporary({
    allowUnsupportedDirectoryDurability: process.platform === "win32", displayPath: ".index.ts.temporary",
    expectedIdentity: observed.identity, parent, temporaryPath,
    rm: (path) => rm(path), syncDirectory: syncDirectoryDurably
  }), "removed");
  const terminal = "src/.foundation-retired-evidence-";
  const [token] = await readdir(join(root, terminal));
  assert.ok(token);
  const path = `${terminal}/${token}/owned-temporary`;
  return { root, counterpart, path, inspect: () => inspectRetiredTemporaryDuplicates(root, [counterpart, path]) };
}

test("actual native retirement excludes only an inode duplicate of a still-governed sibling", async (t) => {
  const { root, counterpart, path, inspect } = await retiredFixture(t);
  assert.deepEqual(await inspect(), [{ path, counterpart }]);
  await rm(join(root, counterpart));
  assert.deepEqual(await inspectRetiredTemporaryDuplicates(root, [path]), [], "a terminal name alone proves nothing");
  await writeFile(join(root, counterpart), "export const guarded = true;\n");
  assert.deepEqual(await inspect(), [], "equal bytes without physical custody cannot hide executable source");
});

test("ordinary broad censuses retain the existing 500000-entry discovery budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "TEST-retired-census-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ordinaryFiles = Array.from({ length: 100_001 }, (_, index) => `docs/entry-${index}.md`);
  assert.deepEqual(await inspectRetiredTemporaryDuplicates(root, ordinaryFiles), []);
});

test("retirement duplicate observation rejects extra, nested, forged and symlink evidence", async (t) => {
  const { root, counterpart, path, inspect } = await retiredFixture(t);
  const extra = join(root, dirname(path), "hidden.ts");
  await writeFile(extra, "export const hidden = true;\n");
  assert.deepEqual(await inspect(), []);
  await rm(extra);
  await link(join(root, counterpart), extra);
  assert.deepEqual(await inspect(), [], "a third hardlink cannot grant duplicate authority");
  await rm(extra);
  const forged = "src/.foundation-retired-evidence-/not-a-native-token/owned-temporary";
  await mkdir(dirname(join(root, forged)), { recursive: true });
  await writeFile(join(root, forged), "export const hidden = true;\n");
  assert.deepEqual(await inspectRetiredTemporaryDuplicates(root, [counterpart, forged]), []);
  await rm(join(root, path));
  await symlink(join(root, counterpart), join(root, path));
  assert.deepEqual(await inspect(), []);
  await assert.rejects(inspectRetiredTemporaryDuplicates(root, ["../escape"]), /contained repository census/u);
});

test("quality reader preserves canonical executable coverage after real native retirement", async (t) => {
  const { root, reader, run } = await fixture(t);
  const temporaryPath = join(root, sourceRoot, ".main.ts.temporary");
  await link(join(root, main), temporaryPath);
  const observed = await readBoundedRegularFile(temporaryPath, 1024);
  if (observed.outcome !== "read") { throw new Error("missing owned temporary"); }
  assert.equal(await cleanupIdentityMatchingOwnedTemporary({
    allowUnsupportedDirectoryDurability: process.platform === "win32", displayPath: ".main.ts.temporary",
    expectedIdentity: observed.identity, parent: join(root, sourceRoot), temporaryPath,
    rm: (path) => rm(path), syncDirectory: syncDirectoryDurably
  }), "removed");
  assert.equal((await run()).outcome, "passed");
  const before = await reader.read(root, "quality.yaml");
  assert.deepEqual(before.sources.find(({ path }) => path === main)?.owners, ["example"]);
  assert.ok(!before.sources.some(({ path }) => path.includes(".foundation-retired-evidence-")));
  const [token] = await readdir(join(root, sourceRoot, ".foundation-retired-evidence-"));
  const hidden = `${sourceRoot}/.foundation-retired-evidence-/${token}/nested/hidden.ts`;
  await mkdir(dirname(join(root, hidden)), { recursive: true });
  await writeFile(join(root, hidden), "export const hidden = true;\n");
  const report = await run();
  assert.equal(report.outcome, "violations");
  assert.ok((await reader.read(root, "quality.yaml")).sources.some(({ path }) => path === hidden),
    "the added executable retains ordinary typed selection rather than receiving retirement status");
  await rm(join(root, hidden));
  await symlink(join(root, proto), join(root, `${proto}.linked.proto`));
  assert.equal((await run()).outcome, "invalid-input", "asset declarations cannot hide source symlinks");
});

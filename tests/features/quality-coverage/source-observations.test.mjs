import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createSourceCensusReader } from "../../../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";
import { loadStrictYamlFile } from "../../../packages/engineering-foundation/dist/features/configuration-input/node.js";
import { createQualityCoverageReader } from "../../../packages/engineering-foundation/dist/features/quality-coverage/node.js";
import { classifyQualityCensus, checkStaticQualityCoverage, qualitySourceLanguage } from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import { mapQualityTopology } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/profile-input.js";
import { copyPinnedToolchain } from "./copied-toolchain.mjs";

const moduleRoot = "packages/contexts/private-worker";
const sourceRoot = `${moduleRoot}/src`;
const main = `${sourceRoot}/main.ts`;
const compilerProject = `${sourceRoot}/tsconfig.json`;
const topology = {
  productionRoots: ["packages"], applicationRoots: [], excludedRoots: ["spikes"],
  modules: [{ root: moduleRoot, sourceRoot, testRoots: [`${moduleRoot}/tests`] }]
};
const authority = { workspaceManifestPath: "pnpm-workspace.yaml", boundaries: [{ id: "worker", roots: [sourceRoot] }] };
const censusReader = createSourceCensusReader({ read: readContainedRegularFile });

async function assertCanonicalRootAlias(t, root, reader) {
  const aliasRoot = `${root}-alias`;
  await symlink(root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(aliasRoot, { force: true }));
  const report = await checkStaticQualityCoverage(
    { consumerRoot: aliasRoot, configPath: "quality.yaml" },
    reader
  );
  assert.equal(report.outcome, "passed", "canonical consumer aliases retain contained Oxlint config");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "quality coverage nested "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  };
  await put(`${moduleRoot}/package.json`, JSON.stringify({ name: "@fixture/worker", private: true, type: "module" }));
  await put(main, "export const value = 1;\n");
  return { root, put, census: () => censusReader.read({ consumerRoot: root, roots: ["packages"] }) };
}

test("independent nested/private census includes untracked and unclassified source without Git or workspace selection", async (t) => {
  const { put, census } = await fixture(t);
  await put("pnpm-workspace.yaml", "packages: ['packages/public/*']\n");
  await put(`${sourceRoot}/fixtures/production.test.ts`, "export const production = true;\n");
  await put(`${moduleRoot}/new-root/hidden.ts`, "export const hidden = true;\n");
  await put(`${moduleRoot}/tests/fixture.ts`, "export const fixture = true;\n");
  await put("packages/new-private/package.json", '{"name":"new-private","private":true}');
  await put("packages/new-private/src/new.mts", "export const extra = true;\n");
  const observed = await census();
  const classified = classifyQualityCensus({ ...observed, topology, authority, suppressionRoots: [sourceRoot] });
  assert.deepEqual(classified.unclassifiedPackages, ["packages/new-private/package.json"]);
  assert.deepEqual(classified.sources.map(({ path }) => path), [
    `${moduleRoot}/new-root/hidden.ts`, `${sourceRoot}/fixtures/production.test.ts`, main,
    "packages/new-private/src/new.mts"
  ]);
  assert.deepEqual(classified.sources[0].owners, []);
  assert.deepEqual(classified.sources[1].owners, ["worker"]);
  const report = await checkStaticQualityCoverage({ consumerRoot: "/unused", configPath: "quality.yaml" }, {
    read: async () => ({ ...classified, routes: [], requiredRoutes: [], requiredSettings: [], requiredSettingObservations: [], settings: [] })
  });
  assert.equal(report.outcome, "violations");
  assert.ok(report.diagnostics.some(({ ruleId, location }) => ruleId === "quality.source-coverage.source-language" && location.path === "packages/new-private/src/new.mts"));
  assert.equal(qualitySourceLanguage("packages/new-private/src/new.mts"), "unsupported");
});

test("development ownership classifies external build tooling without hiding production or native source", async (t) => {
  const { put, census } = await fixture(t);
  const scriptsRoot = `${moduleRoot}/scripts`;
  const scripts = ["copy-runtime-assets.mjs", "docker-custody-init/build.mjs", "run-postgres-qualification.mjs",
    "dispatch-source-loader.mjs", "require-postgres-qualification.mjs", "build-native-helper.mjs"]
    .map((name) => `${scriptsRoot}/${name}`);
  for (const path of scripts) { await put(path, "export const build = () => 1;\n"); }
  const observed = await census();
  const tooling = { id: "tooling", roots: [scriptsRoot], dependencyMode: "development" };
  const classify = (boundaries, input = observed) => classifyQualityCensus({
    ...input, topology, authority: { ...authority, boundaries }, suppressionRoots: [sourceRoot, scriptsRoot]
  });
  assert.deepEqual(classify([...authority.boundaries, tooling]).sources.map(({ path }) => path), [main]);
  for (const [boundaries, expectedOwners] of [
    [authority.boundaries, []],
    [[...authority.boundaries, { id: "tooling", roots: [scriptsRoot] }], []],
    [[...authority.boundaries, { ...tooling, dependencyMode: "runtime" }], ["tooling"]]
  ]) {
    const result = classify(boundaries);
    for (const path of scripts) {
      assert.deepEqual(result.sources.find((source) => source.path === path)?.owners, expectedOwners, path);
    }
  }
  const ambiguous = classify([...authority.boundaries, tooling,
    { id: "other", roots: [scripts[0]], dependencyMode: "development" }]);
  assert.deepEqual(ambiguous.sources.find(({ path }) => path === scripts[0])?.owners, []);
  const production = classify([{ ...authority.boundaries[0], dependencyMode: "development" }, tooling]);
  assert.deepEqual(production.sources.map(({ path }) => path), [main]);
  assert.deepEqual(production.sources[0].owners, ["worker"]);
  const native = `${scriptsRoot}/helper.c`;
  await put(native, "int helper(void) { return 0; }\n");
  const withNative = classify([...authority.boundaries, tooling], await census());
  assert.deepEqual(withNative.sources.find(({ path }) => path === native)?.owners, ["tooling"]);
  const report = await checkStaticQualityCoverage({ consumerRoot: "/unused", configPath: "quality.yaml" }, {
    read: async () => ({ ...withNative, routes: [], requiredRoutes: [], requiredSettings: [], requiredSettingObservations: [], settings: [] })
  });
  assert.ok(report.diagnostics.some(({ ruleId, location }) => ruleId === "quality.source-coverage.native-route" && location.path === native));
});

test("nested application packages use exact production sources without promoting tests or scripts", async (t) => {
  const { root, put } = await fixture(t);
  const appRoot = "apps/app";
  const appSource = `${appRoot}/src`;
  const appMain = `${appSource}/main.ts`;
  const appTest = `${appRoot}/tests/main.test.ts`;
  const appScript = `${appRoot}/scripts/build.mjs`;
  for (const path of [appMain, appTest, appScript]) { await put(path, "export const value = 1;\n"); }
  const profile = {
    schemaVersion: 1, authority: { id: "agent-teams.feature-module-standard", version: "v1" },
    scope: { workspaceContainers: ["packages"], productionRoots: [sourceRoot, appSource],
      productionModules: [
        { moduleRoot, sourceRoot, adoption: "pending" },
        { moduleRoot: appRoot, sourceRoot: appSource, adoption: "active" }
      ] },
    adoption: { applicationRoots: [appRoot], excludedRoots: [`${appRoot}/tests`],
      abstractLayout: { modules: [{ moduleRoot, sourceRoot, testRoot: `${moduleRoot}/tests` }] } }
  };
  const mapped = mapQualityTopology(profile, "source.yaml");
  assert.deepEqual(mapped.applicationRoots, [appRoot], "discovery retains application packages outside workspace containers");
  assert.deepEqual(mapped.productionSourceRoots, [sourceRoot, appSource], "typed execution receives only production sources");
  assert.deepEqual(mapped.modules.map(({ sourceRoot: path }) => path), [sourceRoot, appSource], "pending module sources remain covered");
  assert.deepEqual(mapQualityTopology({ ...topology, schemaVersion: 1,
    standard: profile.authority, topology: { sourcePolicy: "source.yaml" } }, "source.yaml"),
  { ...topology, toolingFiles: [] }, "flat source mappings remain unchanged");
  const observed = await censusReader.read({ consumerRoot: root, roots: [...mapped.productionRoots, ...mapped.applicationRoots] });
  assert.ok(observed.sourcePaths.includes(appTest), "independent discovery still sees application tests");
  assert.ok(observed.sourcePaths.includes(appScript), "independent discovery still sees application scripts");
  const classified = classifyQualityCensus({ ...observed, topology: mapped,
    authority: { ...authority, boundaries: [...authority.boundaries,
      { id: "app", roots: [appSource] },
      { id: "tooling", roots: [`${appRoot}/scripts`], dependencyMode: "development" }] },
    suppressionRoots: [sourceRoot, appSource] });
  assert.deepEqual(classified.sources.map(({ path }) => path), [appMain, main]);
  assert.deepEqual(classified.sources.map(({ owners }) => owners), [["app"], ["worker"]]);
  assert.throws(() => mapQualityTopology({ ...profile,
    scope: { ...profile.scope, productionRoots: [sourceRoot] } }, "source.yaml"),
  /application must map an existing production source root/u);
});

test("native and unknown files inside owned source cannot disappear at discovery", async (t) => {
  const { put, census } = await fixture(t);
  await put(`${sourceRoot}/README.md`, "# Source documentation\n");
  for (const name of ["native.c", "native.h", "unknown.future"]) {
    await put(`${sourceRoot}/${name}`, "source input\n");
  }
  const observed = await census();
  const classified = classifyQualityCensus({ ...observed, topology, authority, suppressionRoots: [sourceRoot] });
  assert.ok(observed.filePaths.includes(`${sourceRoot}/README.md`));
  assert.ok(!classified.sources.some(({ path }) => path === `${sourceRoot}/README.md`));
  const report = await checkStaticQualityCoverage({ consumerRoot: "/unused", configPath: "quality.yaml" }, {
    read: async () => ({ ...classified, routes: [], requiredRoutes: [], requiredSettings: [], requiredSettingObservations: [], settings: [] })
  });
  for (const name of ["native.c", "native.h", "unknown.future"]) {
    assert.ok(observed.filePaths.includes(`${sourceRoot}/${name}`));
    const expectedRule = name === "unknown.future" ? "source-language" : "native-route";
    assert.ok(report.diagnostics.some(({ ruleId, location }) => ruleId === `quality.source-coverage.${expectedRule}` && location.path === `${sourceRoot}/${name}`));
  }
});

test("declared compiler JSON does not hide adjacent files or independently discovered source", async (t) => {
  const { put, census } = await fixture(t);
  const config = `${sourceRoot}/tsconfig.json`;
  const adjacent = `${sourceRoot}/data.json`;
  const protectedPaths = [main, ...["build.mjs", "helper.c", "helper.h"].map((name) => `${sourceRoot}/${name}`)];
  for (const path of [config, adjacent, ...protectedPaths]) { await put(path, "{}\n"); }
  const observed = await census();
  const input = { ...observed, topology, authority, suppressionRoots: [sourceRoot],
    compilerProjects: [config, ...protectedPaths] };
  const classified = classifyQualityCensus(input);
  assert.ok(observed.filePaths.includes(config));
  assert.deepEqual(classified.compilerConfigPaths, [config]);
  assert.ok(!classified.sources.some(({ path }) => path === config));
  for (const path of [adjacent, ...protectedPaths]) {
    assert.ok(classified.sources.some((source) => source.path === path), path);
  }
  const report = await checkStaticQualityCoverage({ consumerRoot: "/unused", configPath: "quality.yaml" }, {
    read: async () => ({ ...classified, routes: [], requiredRoutes: [], requiredSettings: [], requiredSettingObservations: [], settings: [] })
  });
  assert.ok(report.diagnostics.some(({ ruleId, location }) =>
    ruleId === "quality.source-coverage.source-language" && location.path === adjacent));
  const explicit = classifyQualityCensus({ ...input, sourcePaths: [...observed.sourcePaths, config] });
  assert.ok(explicit.sources.some(({ path }) => path === config));
  assert.deepEqual(explicit.compilerConfigPaths, []);
});

test("native package roots outside src require consumer classification", async (t) => {
  const { put, census } = await fixture(t);
  const native = `${moduleRoot}/native/helper.c`;
  const header = `${moduleRoot}/native/helper.h`;
  const harness = `${moduleRoot}/tests/harness.c`;
  for (const path of [native, header, harness]) { await put(path, "/* source */\n"); }
  const observed = await census();
  const input = { ...observed, topology, authority, suppressionRoots: [sourceRoot] };
  const unclassified = classifyQualityCensus(input);
  assert.deepEqual(unclassified.sources.map(({ path }) => path), [native, header, main]);
  assert.deepEqual(unclassified.sources[0].owners, []);
  const nativeRoot = `${moduleRoot}/native`;
  const classified = classifyQualityCensus({
    ...input,
    topology: { ...topology, applicationRoots: [nativeRoot] },
    authority: { ...authority, boundaries: [...authority.boundaries, { id: "native", roots: [nativeRoot] }] },
    suppressionRoots: [sourceRoot, nativeRoot]
  });
  assert.deepEqual(classified.sources[0].owners, ["native"]);
  assert.equal(classified.sources[0].suppressionCovered, true);
  assert.ok(!classified.sources.some(({ path }) => path === harness));
});

test("owned TypeScript declarations remain in the independent production census", async (t) => {
  const { put, census } = await fixture(t);
  const declarations = [`${sourceRoot}/public.d.ts`, `${sourceRoot}/public.d.mts`];
  for (const declaration of declarations) {
    await put(declaration, "export declare const value: number;\n");
  }
  const classified = classifyQualityCensus({ ...await census(), topology, authority, suppressionRoots: [sourceRoot] });
  assert.deepEqual(classified.sources.map(({ path }) => path), [main, ...declarations].toSorted());
  for (const declaration of declarations) {
    const source = classified.sources.find(({ path }) => path === declaration);
    assert.deepEqual(source?.owners, ["worker"]);
    assert.equal(source?.suppressionCovered, true);
    assert.equal(qualitySourceLanguage(declaration), "typescript");
  }
});

test("pure module markers cannot hide nested dist source and source symlinks reject", async (t) => {
  const { root, put, census } = await fixture(t);
  await put(`${moduleRoot}/dist/output.js`, "export const built = 1;\n");
  await put(`${sourceRoot}/marker/package.json`, '{"type":"module"}');
  const nested = `${sourceRoot}/marker/dist/source.ts`;
  await put(nested, "export const source = 1;\n");
  assert.deepEqual((await census()).sourcePaths, [main, nested]);
  await symlink(join(root, main), join(root, sourceRoot, "linked.ts"));
  await assert.rejects(census(), /symbolic link/u);
});

test("static reader joins owned authorities and rejects removed or scope-only full activation", async (t) => {
  const { root, put } = await fixture(t);
  const profile = {
    schemaVersion: 1, sourcePolicyPath: "source.yaml", suppressionPolicyPath: "suppressions.yaml",
    featureProfilePath: "features.json", lintConfigPath: "lint.json", compilerProjects: [compilerProject],
    scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" }
  };
  await put("quality.yaml", JSON.stringify(profile));
  await put(compilerProject, JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", types: [], noEmit: true },
    include: ["./**/*.ts"]
  }));
  await put("features.json", JSON.stringify({
    ...topology, schemaVersion: 1, standard: { id: "agent-teams.feature-module-standard", version: "v1" },
    topology: { sourcePolicy: "source.yaml" }
  }));
  const typed = JSON.parse(await readFile(new URL("../../../packages/engineering-foundation/presets/oxlint/type-aware.json", import.meta.url), "utf8"));
  const maintainability = JSON.parse(await readFile(new URL("../../../packages/engineering-foundation/presets/oxlint/maintainability.json", import.meta.url), "utf8"));
  await put("lint.json", JSON.stringify({ options: { ...typed.options, respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" }, rules: { ...typed.rules, ...maintainability.rules } }));
  const nestedProfile = {
    schemaVersion: 1, authority: { id: "agent-teams.feature-module-standard", version: "v1" },
    scope: {
      workspaceContainers: ["packages/contexts"],
      productionModules: [{ moduleRoot, sourceRoot, adoption: "pending" }]
    },
    adoption: { applicationRoots: [], excludedRoots: ["spikes"], abstractLayout: {
      modules: [{ moduleRoot, sourceRoot, testRoot: `${moduleRoot}/tests` }], applications: []
    } }
  };
  const scripts = {
    "check:fast": "pnpm quality:scope", check: "pnpm lint:typed",
    "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
    "lint:typed": "agent-teams-foundation quality check --consumer ."
  };
  const packages = [{ rootPath: "spikes/parser", manifestPath: "spikes/parser/package.json" }];
  const reader = createQualityCoverageReader({
    census: censusReader, inventory: { read: async () => ({ packages, catalogs: [] }) },
    authority: { source: async () => authority, suppressions: async () => ({ governedRoots: [sourceRoot] }) }
  }, { read: loadStrictYamlFile, assertProfile: async (value) => assert.deepEqual(value, profile) }, readContainedRegularFile);
  const run = () => checkStaticQualityCoverage({ consumerRoot: root, configPath: "quality.yaml" }, reader);
  await put("package.json", JSON.stringify({ scripts }));
  assert.equal((await run()).outcome, "passed");
  const lintBytes = await readFile(join(root, "lint.json"), "utf8");
  await put("suppression-base.json", lintBytes);
  await put("lint.json", JSON.stringify({ extends: ["./suppression-base.json"] }));
  assert.equal((await run()).outcome, "violations", "root-only suppression options cannot be inherited");
  const missingOptions = JSON.parse(lintBytes);
  delete missingOptions.options.respectEslintDisableDirectives;
  delete missingOptions.options.reportUnusedDisableDirectives;
  await put("lint.json", JSON.stringify(missingOptions));
  assert.equal((await run()).outcome, "violations", "missing root-only options cannot imply protection");
  await put("lint.json", lintBytes);
  await put("untyped-base.json", JSON.stringify({ options: { typeAware: false } }));
  await put("lint.json", JSON.stringify({ ...JSON.parse(lintBytes), extends: ["./untyped-base.json"] }));
  assert.equal((await run()).outcome, "passed", "typed activation may extend an untyped base");
  await assertCanonicalRootAlias(t, root, reader);
  await put("typed-base.json", lintBytes);
  await put("lint.json", JSON.stringify({ extends: ["./typed-base.json"], options: { typeAware: false } }));
  assert.equal((await run()).outcome, "violations", "a consumer cannot disable inherited typed activation");
  await put("lint.json", lintBytes);
  const featureBytes = await readFile(join(root, "features.json"), "utf8");
  const generator = `${moduleRoot}/scripts/generate.mjs`;
  const features = JSON.parse(featureBytes);
  features.modules[0].generatedRoots = [{ root: `${sourceRoot}/generated`, generator, sources: [main] }];
  await put("features.json", JSON.stringify(features));
  await put(generator, "export const generate = () => 1;\n");
  assert.equal((await run()).outcome, "passed", "an exact external generator is classified by existing provenance");
  const newScript = `${moduleRoot}/scripts/unclassified.mjs`;
  await put(newScript, "export const unknown = 1;\n");
  assert.ok((await run()).diagnostics.some(({ ruleId, location }) => ruleId === "quality.source-coverage.source-classification" && location.path === newScript));
  await rm(join(root, moduleRoot, "scripts"), { recursive: true });
  features.modules[0].generatedRoots[0].generator = main;
  await put("features.json", JSON.stringify(features));
  const withProductionGenerator = await reader.read(root, "quality.yaml");
  assert.ok(withProductionGenerator.sources.some(({ path }) => path === main), "production generators retain ordinary protection");
  await put("features.json", featureBytes);
  const stronger = { ...JSON.parse(lintBytes), rules: {
    ...JSON.parse(lintBytes).rules, "max-lines": ["error", { max: 300 }]
  } };
  await put("stronger.json", JSON.stringify(stronger));
  for (const maximum of [250, 300, 400]) {
    await put("lint.json", JSON.stringify({ extends: ["./stronger.json"], options: JSON.parse(lintBytes).options, rules: { "max-lines": ["error", { max: maximum }] } }));
    const inherited = await run();
    assert.equal(inherited.outcome, maximum <= 300 ? "passed" : "violations");
    if (maximum > 300) {
      assert.ok(inherited.diagnostics.some(({ ruleId }) => ruleId === "quality.source-coverage.protected-setting"));
    }
  }
  await put("lint.json", JSON.stringify({ ...stronger, overrides: [{
    files: [`${sourceRoot}/**`], rules: { "max-lines": ["error", { max: 400 }] }
  }] }));
  assert.equal((await run()).outcome, "violations");
  await put("lint.json", lintBytes);
  await put(`${moduleRoot}/tests/example.test.ts`, "export const example = true;\n");
  const withOverride = async (files, maximum = 800) => {
    await put("lint.json", JSON.stringify({ ...JSON.parse(lintBytes), overrides: [{ files, rules: { "max-lines": ["error", { max: maximum }] } }] }));
    return run();
  };
  assert.equal((await withOverride([`${moduleRoot}/tests/**`])).outcome, "passed");
  assert.equal((await withOverride([`${sourceRoot}/**`], 300)).outcome, "passed");
  assert.equal((await withOverride([compilerProject], 300)).outcome, "invalid-input");
  await put(`${sourceRoot}/unknown.json`, "{}");
  const unknownJson = await withOverride([`${sourceRoot}/**`], 300);
  assert.equal(unknownJson.outcome, "violations");
  assert.ok(unknownJson.diagnostics.some(({ ruleId, location }) =>
    ruleId === "quality.source-coverage.source-language" && location.path === `${sourceRoot}/unknown.json`));
  await rm(join(root, sourceRoot, "unknown.json"));

  for (const maximum of ["800", null, -1]) {
    assert.equal((await withOverride([`${moduleRoot}/tests/**`], maximum)).outcome, "violations");
  }
  await put(`${sourceRoot}/fixtures/production.test.ts`, "export const production = true;\n");
  for (const files of [["**/*.test.ts"], [`${sourceRoot}/fixtures/**`]]) {
    const overlapping = await withOverride(files);
    assert.equal(overlapping.outcome, "violations");
    assert.ok(overlapping.diagnostics.some(({ ruleId }) => ruleId === "quality.source-coverage.protected-setting"));
  }
  assert.equal((await withOverride(["unknown-tests/**"])).outcome, "invalid-input");
  await put("lint.json", JSON.stringify({ ...JSON.parse(lintBytes), overrides: [{
    files: [`${moduleRoot}/tests/**`], rules: { "typescript/no-floating-promises": "off" }
  }] }));
  assert.equal((await run()).outcome, "violations");
  await put("lint.json", lintBytes);
  await rm(join(root, sourceRoot, "fixtures"), { recursive: true });
  for (const command of [undefined, "true", "echo quality check", "true || pnpm lint:typed", scripts["quality:scope"]]) {
    await put("package.json", JSON.stringify({ scripts: { ...scripts, "lint:typed": command } }));
    const report = await run();
    assert.equal(report.outcome, "violations");
    assert.ok(report.diagnostics.some(({ ruleId }) => ruleId === "quality.source-coverage.required-route"));
  }
  await put("package.json", JSON.stringify({ scripts }));
  packages.push({ rootPath: "new-root/worker", manifestPath: "new-root/worker/package.json" });
  const unknown = await run();
  assert.equal(unknown.outcome, "violations");
  assert.ok(unknown.diagnostics.some(({ ruleId, location }) => ruleId === "quality.source-coverage.source-package" && location.path === "new-root/worker/package.json"));

  await put("features.json", JSON.stringify(nestedProfile));
  packages.pop();
  assert.equal((await run()).outcome, "passed", "structural pending status must not suppress quality scope");
  await put(`${sourceRoot}/unclassified.future`, "unknown language\n");
  const pendingSource = await run();
  assert.ok(pendingSource.diagnostics.some(({ ruleId, location }) => ruleId === "quality.source-coverage.source-language" && location.path === `${sourceRoot}/unclassified.future`));
  await rm(join(root, sourceRoot, "unclassified.future"));
  await put("features.json", JSON.stringify({ ...nestedProfile, adoption: { ...nestedProfile.adoption,
    abstractLayout: { modules: [{ moduleRoot, sourceRoot: "wrong/src", testRoot: `${moduleRoot}/tests` }] }
  } }));
  assert.equal((await run()).outcome, "invalid-input");
  await put("features.json", JSON.stringify(nestedProfile));

  // Exercise the built public command host with the nested profile and real schema/policy readers.
  await put("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts }));
  await put("pnpm-workspace.yaml", "packages: ['packages/contexts/*']\n");
  await put("source.yaml", JSON.stringify({
    schemaVersion: 3, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: ["packages/contexts"], governedRoots: [sourceRoot],
    boundaries: [{ id: "worker", roots: [sourceRoot], entrypoints: [main],
      allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } }]
  }));
  await put("suppressions.yaml", JSON.stringify({ schemaVersion: 1, governedRoots: [sourceRoot], nonWaivableRulePrefixes: [], waivers: [] }));
  const rootConfig = { schemaVersion: 2, project: { id: "fixture" }, capabilities: {
    "quality.source-coverage": { configPath: "quality.yaml" }
  } };
  await put("foundation.config.yaml", JSON.stringify(rootConfig));
  const cli = fileURLToPath(new URL("../../../packages/engineering-foundation/dist/cli.js", import.meta.url));
  const invoke = async (args, consumerRoot = root) => {
    try { return { code: 0, ...await promisify(execFile)(process.execPath, [cli, ...args, "--consumer", consumerRoot, "--format", "json"], { timeout: 30_000, maxBuffer: 1024 * 1024 }) }; }
    catch (error) { return error; }
  };
  const staticResult = await invoke(["check", "quality.source-coverage"]);
  assert.equal(staticResult.code, 0, staticResult.stdout || staticResult.stderr);
  assert.equal(JSON.parse(staticResult.stdout).outcome, "passed");
  const { nativePath, nativeProfile, nativeScript, nativeScripts } = await qualifyNativeRoutes({ root, put, invoke, profile, scripts });
  const strongerConfig = { ...JSON.parse(lintBytes), rules: {
    ...JSON.parse(lintBytes).rules, "typescript/no-unsafe-type-assertion": "error"
  } };
  await put("lint.json", JSON.stringify(strongerConfig));
  const strongerResult = await invoke(["check", "quality.source-coverage"]);
  assert.equal(strongerResult.code, 0, strongerResult.stdout || strongerResult.stderr);
  await put("protected-base.json", JSON.stringify(strongerConfig));
  await put("lint.json", JSON.stringify({ extends: ["./protected-base.json"], overrides: [{
    files: [`${sourceRoot}/**`], rules: { "typescript/no-floating-promises": "off" }
  }] }));
  const weakenedGroup = await invoke(["check", "quality.source-coverage"]);
  assert.equal(weakenedGroup.code, 1, weakenedGroup.stdout || weakenedGroup.stderr);
  assert.ok(JSON.parse(weakenedGroup.stdout).capabilities[0].diagnostics.some(({ ruleId, location, subject }) =>
    ruleId === "quality.source-coverage.protected-setting" && location.path === "lint.json" && subject === "typescript/no-floating-promises"));
  await put("lint.json", lintBytes);
  for (const compilerProjects of [[], null, ["missing.json"], [compilerProject, compilerProject], ["../outside.json"]]) {
    await put("quality.yaml", JSON.stringify({ ...profile, compilerProjects }));
    const invalid = await invoke(["check", "quality.source-coverage"]);
    assert.equal(invalid.code, 2, invalid.stdout || invalid.stderr);
    assert.notEqual(JSON.parse(invalid.stdout).outcome, "passed");
  }
  await put("quality.yaml", JSON.stringify(profile));
  const absentTools = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(absentTools.code, 2, absentTools.stdout || absentTools.stderr);
  const failure = JSON.parse(absentTools.stdout);
  assert.equal(failure.outcome, "invalid-input");
  assert.equal(failure.capabilities[0].problem.code, "QUALITY_TOOLCHAIN_INVALID");
  assert.deepEqual(failure.capabilities[0].diagnostics, []);
  const devDependencies = await copyPinnedToolchain(root);
  await put("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts, devDependencies }));
  await put(`${sourceRoot}/owned.d.ts`, "export declare const declared: number;\n");
  await put(`${sourceRoot}/build.mjs`, "export const build = () => 1;\n");
  await put(nativePath, "int helper(void) { return 0; }\n");
  await put(nativeScript, "throw new Error('native execution belongs to the consumer gate');\n");
  await put("quality.yaml", JSON.stringify(nativeProfile));
  await put("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts: nativeScripts, devDependencies }));
  const scoped = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(scoped.code, 0, scoped.stdout || scoped.stderr);
  for (const args of [["quality", "check", "--scope-only"], ["quality", "check"]]) {
    const aliased = await invoke(args, `${root}-alias`);
    assert.equal(aliased.code, 0, aliased.stdout || aliased.stderr);
    assert.equal(JSON.parse(aliased.stdout).outcome, "passed");
  }
  const projectBytes = await readFile(join(root, compilerProject), "utf8");
  await put(compilerProject, JSON.stringify({ ...JSON.parse(projectBytes), include: ["../missing/**/*.ts"] }));
  const absentContext = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(absentContext.code, 3, absentContext.stdout || absentContext.stderr);
  assert.equal(JSON.parse(absentContext.stdout).outcome, "failed");
  assert.deepEqual(JSON.parse(absentContext.stdout).capabilities[0].diagnostics, []);
  await put(compilerProject, `// Accepted compiler JSONC input\n${projectBytes}`);
  const validJsonc = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(validJsonc.code, 0, validJsonc.stdout || validJsonc.stderr);
  await put(compilerProject, "{ invalid JSONC");
  const malformed = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(malformed.code, 3, malformed.stdout || malformed.stderr);
  assert.equal(JSON.parse(malformed.stdout).outcome, "failed");
  assert.deepEqual(JSON.parse(malformed.stdout).capabilities[0].diagnostics, []);
  await put(compilerProject, `// Restored compiler JSONC input\n${projectBytes}`);
  const full = await invoke(["quality", "check"]);
  assert.equal(full.code, 0, full.stdout || full.stderr);
  await Promise.all([rm(join(root, nativePath)), rm(join(root, nativeScript))]);
  await put("quality.yaml", JSON.stringify(profile));
  await put("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts, devDependencies }));
  await put(`${sourceRoot}/build.mjs`, Array.from({ length: 501 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n");
  const javascriptBad = await invoke(["quality", "check"]);
  assert.equal(javascriptBad.code, 1, javascriptBad.stdout || javascriptBad.stderr);
  assert.ok(JSON.parse(javascriptBad.stdout).capabilities[0].diagnostics.some(({ location, evidence }) =>
    location.path === `${sourceRoot}/build.mjs` && evidence.some(({ value }) => value === "eslint(max-lines)")), javascriptBad.stdout);
  await put(`${sourceRoot}/build.mjs`, "export const build = () => 1;\n");
  const javascriptGood = await invoke(["quality", "check"]);
  assert.equal(javascriptGood.code, 0, javascriptGood.stdout || javascriptGood.stderr);
  await put(main, "export const value = Promise.resolve(1);\nPromise.resolve(2);\n");
  const bad = await invoke(["quality", "check"]);
  assert.equal(bad.code, 1, bad.stdout || bad.stderr);
  const findings = JSON.parse(bad.stdout).capabilities[0].diagnostics;
  assert.ok(findings.some(({ location, evidence }) => location.path === main && evidence.some(({ value }) => value === "typescript(no-floating-promises)")), bad.stdout);
  await put(main, "export const value = Promise.resolve(1);\nvoid Promise.resolve(2);\n");
  const corrected = await invoke(["quality", "check"]);
  assert.equal(corrected.code, 0, corrected.stdout || corrected.stderr);
  await put("foundation.config.yaml", JSON.stringify({ ...rootConfig, schemaVersion: 1 }));
  assert.equal((await invoke(["quality", "check"])).code, 2, "immutable root v1 must reject the new activation");
});

async function qualifyNativeRoutes({ root, put, invoke, profile, scripts }) {
  const nativePath = `${sourceRoot}/native/helper.c`;
  const nativeScript = "scripts/architecture/native-quality.mjs";
  const nativeProfile = { ...profile, nativeChecks: [{ boundaryId: "worker", script: "native:check" }] };
  // The real nested consumer uses these product/lint chains. A scoped native
  // script is additive wiring; quality coverage does not execute product tests.
  const nativeScripts = { ...scripts, check: "pnpm product:check && pnpm lint && pnpm native:check",
    lint: "pnpm lint:typed",
    "product:check": "pnpm --filter './packages/**' -r run clean && pnpm product:build && pnpm --filter './packages/**' -r run test",
    "native:check": "node scripts/architecture/../architecture/native-quality.mjs" };
  // Static qualification proves wiring only: this consumer leaf must never execute here.
  await put(nativeScript, "throw new Error('native execution belongs to the consumer gate');\n");
  await put(nativePath, "int helper(void) { return 0; }\n");
  await put("quality.yaml", JSON.stringify(nativeProfile));
  await put("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts: nativeScripts }));
  assert.equal((await invoke(["check", "quality.source-coverage"])).code, 0);
  for (const command of [undefined, "true", "true || node scripts/architecture/native-quality.mjs"]) {
    await put("package.json", JSON.stringify({ scripts: { ...nativeScripts, "native:check": command } }));
    const rejected = await invoke(["check", "quality.source-coverage"]);
    assert.equal(rejected.code, 1, rejected.stdout || rejected.stderr);
    assert.ok(JSON.parse(rejected.stdout).capabilities[0].diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.native-route" && location.path === nativePath));
  }
  await put("package.json", JSON.stringify({ scripts: { ...nativeScripts, check: scripts.check } }));
  const unreachableNative = await invoke(["check", "quality.source-coverage"]);
  assert.equal(unreachableNative.code, 1, unreachableNative.stdout || unreachableNative.stderr);
  assert.ok(JSON.parse(unreachableNative.stdout).capabilities[0].diagnostics.some(({ ruleId, location }) =>
    ruleId === "quality.source-coverage.native-route" && location.path === nativePath));
  await put("package.json", JSON.stringify({ scripts: nativeScripts }));
  await rm(join(root, nativeScript));
  assert.equal((await invoke(["check", "quality.source-coverage"])).code, 2);
  await put(nativeScript, "throw new Error('native execution belongs to the consumer gate');\n");
  for (const nativeChecks of [[], [...nativeProfile.nativeChecks, { boundaryId: "worker", script: "other:check" }]]) {
    await put("quality.yaml", JSON.stringify({ ...profile, nativeChecks }));
    const rejected = await invoke(["check", "quality.source-coverage"]);
    assert.equal(rejected.code, 1, rejected.stdout || rejected.stderr);
    assert.ok(JSON.parse(rejected.stdout).capabilities[0].diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.native-route" && location.path === nativePath));
  }
  await put("quality.yaml", JSON.stringify({ ...profile, nativeChecks: [{ boundaryId: "unknown", script: "native:check" }] }));
  assert.equal((await invoke(["check", "quality.source-coverage"])).code, 2);
  await put("quality.yaml", JSON.stringify(nativeProfile));
  await rm(join(root, nativePath));
  const staleNative = await invoke(["check", "quality.source-coverage"]);
  assert.equal(staleNative.code, 2, staleNative.stdout || staleNative.stderr);
  assert.match(JSON.parse(staleNative.stdout).capabilities[0].problem.message, /no current native source/u);
  await put("quality.yaml", JSON.stringify(profile));
  await put("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts }));
  await rm(join(root, nativeScript));
  return { nativePath, nativeProfile, nativeScript, nativeScripts };
}

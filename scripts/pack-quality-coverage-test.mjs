import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { runCommand } from "./pack-test-support.mjs";
import { inspectCompressedTarArchive, readRegularArchive, sha256 } from "./pack-artifact-archive.mjs";

/** Reuse the installed archive closure in an isolated consumer, never the source installation. */
export async function assertInstalledQualityArtifact({ consumerRoot, artifact }) {
  const bytes = await readRegularArchive(artifact.archivePath);
  assert.equal(sha256(bytes), artifact.sha256, "Packed quality archive identity changed");
  const installed = await realpath(join(consumerRoot, "node_modules/@agent-teams/engineering-foundation"));
  const entries = inspectCompressedTarArchive(bytes).entries;
  for (const entry of entries) {
    if (entry.type !== "0") { continue; }
    assert.ok(entry.name.startsWith("package/"));
    const suffix = entry.name.slice("package/".length);
    const path = join(installed, suffix);
    const relativePath = relative(installed, path);
    assert.ok(!isAbsolute(relativePath) && relativePath.split(/[\\/]/u)[0] !== "..");
    assert.ok((await readFile(path)).equals(entry.data), "Installed candidate differs: " + suffix);
  }
}

export async function testPackedQualityCoverage({ consumerRoot, artifact }) {
  await assertInstalledQualityArtifact({ consumerRoot, artifact });
  const flat = await qualifyLayout({ consumerRoot, nested: false, artifact });
  const nested = await qualifyLayout({ consumerRoot, nested: true, artifact });
  return { outcome: "passed", consumers: [flat, nested] };
}

async function qualifyLayout({ consumerRoot, nested, artifact }) {
  const root = join(dirname(consumerRoot), nested ? "quality coverage nested consumer" : "quality coverage flat consumer");
  await mkdir(root, { recursive: true });
  const physicalRoot = await realpath(root);
  await cp(join(consumerRoot, "node_modules"), join(root, "node_modules"), { recursive: true, verbatimSymlinks: true });
  await assertInstalledQualityArtifact({ consumerRoot: root, artifact });
  if (!nested) {
    const schema = join(root, "node_modules/@agent-teams/engineering-foundation/schemas/foundation-config/v2.schema.json");
    const original = await readFile(schema);
    try {
      await writeFile(schema, "{}\n");
      await assert.rejects(assertInstalledQualityArtifact({ consumerRoot: root, artifact }), {
        code: "ERR_ASSERTION", message: "Installed candidate differs: schemas/foundation-config/v2.schema.json"
      });
    } finally { await writeFile(schema, original); }
    await assertInstalledQualityArtifact({ consumerRoot: root, artifact });
  }
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const devDependencies = {};
  for (const name of ["@agent-teams/engineering-foundation", "oxlint", "oxlint-tsgolint", "typescript"]) {
    const manifestPath = await realpath(join(root, "node_modules", name, "package.json"));
    const suffix = relative(physicalRoot, manifestPath);
    assert.ok(!isAbsolute(suffix) && !suffix.startsWith(".."), `Packed dependency escapes consumer: ${name}`);
    devDependencies[name] = JSON.parse(await readFile(manifestPath, "utf8")).version;
  }
  const moduleRoot = nested ? "packages/contexts/private-worker" : "packages/worker";
  const packageContainer = nested ? "packages/contexts" : "packages";
  const sourceRoot = `${moduleRoot}/src`;
  const nativeRoot = `${moduleRoot}/native`;
  const governedRoots = nested ? [sourceRoot, nativeRoot] : [sourceRoot];
  const main = `${sourceRoot}/main.ts`;
  const scripts = {
    "check:fast": "pnpm quality:scope", check: nested ? "pnpm lint:typed && pnpm native:check" : "pnpm lint:typed",
    ...(nested ? { "native:check": "node scripts/check-native.mjs" } : {}),
    "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
    "lint:typed": "agent-teams-foundation quality check --consumer ."
  };
  await put("package.json", { name: "quality-packed-consumer", private: true, type: "module", scripts, devDependencies });
  await put("pnpm-workspace.yaml", `packages: ['${packageContainer}/*']\n`);
  await put(`${moduleRoot}/package.json`, { name: "@fixture/private-worker", private: true, type: "module" });
  await put(main, "export const value = 1;\n");
  if (nested) {
    await put(`${nativeRoot}/helper.c`, "int helper(void) { return 0; }\n");
    await put(`${nativeRoot}/helper.h`, "int helper(void);\n");
    await put("scripts/check-native.mjs", "throw new Error('native execution is consumer-owned');\n");
  }
  await put(`${sourceRoot}/owned.d.ts`, "export declare const declared: number;\n");
  await put(`${sourceRoot}/build.mjs`, "export const build = () => 1;\n");
  await put("config/production.json", {
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", types: [], noEmit: true },
    include: [`../${sourceRoot}/**/*.ts`]
  });
  await put("features.json", nested ? {
    schemaVersion: 1, authority: { id: "agent-teams.feature-module-standard", version: "v1" },
    scope: { workspaceContainers: [packageContainer], productionModules: [{ moduleRoot, sourceRoot }] },
    adoption: { applicationRoots: [], excludedRoots: [], abstractLayout: {
      modules: [{ moduleRoot, sourceRoot, testRoot: `${moduleRoot}/tests` }], applications: []
    } }
  } : {
    schemaVersion: 1, standard: { id: "agent-teams.feature-module-standard", version: "v1" },
    productionRoots: [packageContainer], applicationRoots: [], excludedRoots: [],
    topology: { sourcePolicy: "source.yaml" },
    modules: [{ root: moduleRoot, sourceRoot, testRoots: [`${moduleRoot}/tests`] }]
  });
  await put("source.yaml", {
    schemaVersion: 3, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: [packageContainer], governedRoots,
    boundaries: [{ id: "worker", roots: governedRoots, entrypoints: [main],
      allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } }]
  });
  await put("suppressions.yaml", { schemaVersion: 1, governedRoots, nonWaivableRulePrefixes: [], waivers: [] });
  await put("lint.json", { options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" }, extends: [
    "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/type-aware.json",
    "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/maintainability.json"
  ] });
  await put("quality.yaml", {
    schemaVersion: 1, sourcePolicyPath: "source.yaml", suppressionPolicyPath: "suppressions.yaml",
    featureProfilePath: "features.json", lintConfigPath: "lint.json", compilerProjects: ["config/production.json"],
    ...(nested ? { nativeChecks: [{ boundaryId: "worker", script: "native:check" }] } : {}),
    scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" }
  });
  const activation = { schemaVersion: 2, project: { id: "packed-quality" }, capabilities: {
    "quality.source-coverage": { configPath: "quality.yaml" }
  } };
  await put("foundation.config.yaml", activation);
  const cli = join(root, "node_modules/@agent-teams/engineering-foundation/dist/cli.js");
  const invoke = async (args, code = 0) => {
    let result;
    try { result = { code: 0, ...await runCommand(process.execPath, [cli, ...args, "--consumer", root, "--format", "json"], root) }; }
    catch (error) { result = error; }
    assert.equal(result.code, code, result.stdout || result.stderr || result.message);
    return JSON.parse(result.stdout);
  };
  assert.equal((await invoke(["check", "quality.source-coverage"])).outcome, "passed");
  assert.equal((await invoke(["quality", "check", "--scope-only"])).outcome, "passed");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put(main, "export const value = 1;\nPromise.resolve(2);\n");
  const rejected = await invoke(["quality", "check"], 1);
  assert.ok(rejected.capabilities[0].diagnostics.some(({ location, evidence }) => location.path === main &&
    evidence.some(({ value }) => value === "typescript(no-floating-promises)")));
  await put(main, "export const value = 1;\n// eslint-disable-next-line typescript/no-floating-promises\nPromise.resolve(2);\n");
  const disabled = await invoke(["quality", "check"], 1);
  assert.ok(disabled.capabilities[0].diagnostics.some(({ evidence }) =>
    evidence.some(({ kind, value }) => kind === "tool-rule" && value === "typescript(no-floating-promises)")));
  await put(main, "export const value = 1;\nvoid Promise.resolve(2);\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  if (nested) {
    await qualifyNestedRejections({ root, put, invoke, main, sourceRoot, moduleRoot, scripts, devDependencies, activation });
  }
  return { outcome: "passed", consumerRoot: root, foundationVersion: devDependencies["@agent-teams/engineering-foundation"] };
}

async function qualifyNestedRejections({ root, put, invoke, main, sourceRoot, moduleRoot, scripts, devDependencies, activation }) {
  const qualityProfile = JSON.parse(await readFile(join(root, "quality.yaml"), "utf8"));
  await put("quality.yaml", { ...qualityProfile, nativeChecks: [] });
  const missingNative = await invoke(["quality", "check"], 1);
  for (const extension of ["c", "h"]) {
    assert.ok(missingNative.capabilities[0].diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.native-route" && location.path === `${moduleRoot}/native/helper.${extension}`));
  }
  await put("quality.yaml", qualityProfile);
  await rename(join(root, moduleRoot, "native"), join(root, "native-backup"));
  try {
    const staleNative = await invoke(["check", "quality.source-coverage"], 2);
    assert.match(staleNative.capabilities[0].problem.message, /no current native source/u);
  } finally {
    await rename(join(root, "native-backup"), join(root, moduleRoot, "native"));
  }
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put(main, 'export const value: number = JSON.parse("1");\n');
  const unsafe = await invoke(["quality", "check"], 1);
  assert.ok(unsafe.capabilities[0].diagnostics.some(({ location, evidence }) => location.path === main &&
    evidence.some(({ value }) => value === "typescript(no-unsafe-assignment)")));
  await put(main, "export const value: number = 1;\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  const lintConfig = JSON.parse(await readFile(join(root, "lint.json"), "utf8"));
  await put(".eslintignore", `${main}\n`);
  await put(`${moduleRoot}/.oxlintrc.json`, {
    ignorePatterns: ["**/*.ts"], options: { typeAware: false },
    rules: { "typescript/no-unsafe-assignment": "off" }
  });
  await put("lint.json", { ...lintConfig, ignorePatterns: [main] });
  await put(main, 'export const value: number = JSON.parse("1");\n');
  const excludedSource = await invoke(["quality", "check"], 1);
  assert.ok(excludedSource.capabilities[0].diagnostics.some(({ ruleId, location }) => location.path === main &&
    ruleId === "quality.source-coverage.selection-mismatch"));
  // Config exclusions reject during selection; ignored files and nested config
  // cannot weaken the pinned invocation after that exclusion is repaired.
  await put("lint.json", lintConfig);
  const ignoredUnsafe = await invoke(["quality", "check"], 1);
  assert.ok(ignoredUnsafe.capabilities[0].diagnostics.some(({ location, evidence }) => location.path === main &&
    evidence.some(({ value }) => value === "typescript(no-unsafe-assignment)")));
  await put(main, "export const value: number = 1;\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await rm(join(root, ".eslintignore"));
  await rm(join(root, moduleRoot, ".oxlintrc.json"));
  await put("lint.json", lintConfig);
  for (const weakened of [
    { ...lintConfig, options: { typeAware: false } },
    { ...lintConfig, rules: { "typescript/no-floating-promises": "off" } },
    { ...lintConfig, rules: { "typescript/no-unsafe-assignment": "off" } }
  ]) {
    await put("lint.json", weakened);
    const protection = await invoke(["quality", "check"], 1);
    assert.ok(protection.capabilities[0].diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.protected-setting" && location.path === "lint.json"));
    await put("lint.json", lintConfig);
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  }
  const misleadingTest = `${sourceRoot}/fixtures/production.test.ts`;
  await put(misleadingTest, "export const production = 1;\n");
  await put("lint.json", { ...lintConfig, overrides: [{
    files: ["**/*.test.ts"], rules: { "max-lines": ["error", { max: 800 }] }
  }] });
  const productionOverride = await invoke(["quality", "check"], 1);
  assert.ok(productionOverride.capabilities[0].diagnostics.some(({ ruleId, location }) =>
    ruleId === "quality.source-coverage.protected-setting" && location.path === "lint.json"));
  await put("lint.json", lintConfig);
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await rm(join(root, sourceRoot, "fixtures"), { recursive: true });
  const compilerConfig = JSON.parse(await readFile(join(root, "config/production.json"), "utf8"));
  await put("config/production.json", { ...compilerConfig, exclude: [`../${main}`] });
  const missingContext = await invoke(["quality", "check", "--scope-only"], 1);
  assert.ok(missingContext.capabilities[0].diagnostics.some(({ ruleId, location }) =>
    ruleId === "quality.source-coverage.type-context" && location.path === main));
  await put("config/production.json", compilerConfig);
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put(main, 'import type { declared } from "./owned.js";\nexport const value: typeof declared = 1;\n');
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  const declarationPath = `${sourceRoot}/owned.d.ts`;
  const declarationBytes = await readFile(join(root, declarationPath), "utf8");
  await rm(join(root, declarationPath));
  try {
    const missingDeclaration = await invoke(["quality", "check"], 3);
    assert.equal(missingDeclaration.outcome, "failed");
    assert.equal(missingDeclaration.capabilities[0].diagnostics.length, 0);
  } finally {
    await put(declarationPath, declarationBytes);
  }
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put(main, "export const value: number = 1;\n");
  await qualifyExternalDeclaration({ root, put, invoke, main, compilerConfig });
  const newSource = `${sourceRoot}/new-untracked.ts`;
  await put(newSource, "export const added = 1;\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put(newSource, "export const added = 1;\nPromise.resolve(2);\n");
  const addedViolation = await invoke(["quality", "check"], 1);
  assert.ok(addedViolation.capabilities[0].diagnostics.some(({ location, evidence }) => location.path === newSource &&
    evidence.some(({ value }) => value === "typescript(no-floating-promises)")));
  await rm(join(root, newSource));
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  const unknownPackage = "packages/contexts/new-private";
  await put(`${unknownPackage}/package.json`, { name: "@fixture/new-private", private: true, type: "module" });
  await put(`${unknownPackage}/src/main.ts`, "export const added = 1;\n");
  const unknownScope = await invoke(["quality", "check", "--scope-only"], 1);
  assert.ok(unknownScope.capabilities[0].diagnostics.some(({ ruleId, location }) =>
    ruleId === "quality.source-coverage.source-package" && location.path === `${unknownPackage}/package.json`));
  await rm(join(root, unknownPackage), { recursive: true });
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  for (const [path, code, outcome] of [
    ["quality.yaml", 2, "invalid-input"],
    ["config/production.json", 2, "invalid-input"],
    ["node_modules/oxlint", 2, "invalid-input"]
  ]) {
    await rename(join(root, path), join(root, `${path}.qualification-backup`));
    try {
      const missingInput = await invoke(["quality", "check"], code);
      assert.equal(missingInput.outcome, outcome);
      assert.equal(missingInput.capabilities[0].diagnostics.length, 0);
    } finally {
      await rename(join(root, `${path}.qualification-backup`), join(root, path));
    }
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  }
  for (const terminal of [undefined, "true", "echo quality check", "true || pnpm quality:scope", scripts["quality:scope"]]) {
    await put("package.json", { name: "quality-packed-consumer", private: true, type: "module",
      scripts: { ...scripts, "lint:typed": terminal }, devDependencies });
    const missingRoute = await invoke(["quality", "check"], 1);
    assert.ok(missingRoute.capabilities[0].diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.required-route" && location.path === "package.json"));
  }
  await put("package.json", { name: "quality-packed-consumer", private: true, type: "module", scripts, devDependencies });
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put("foundation.config.yaml", { ...activation, capabilities: {} });
  assert.equal((await invoke(["quality", "check"], 2)).outcome, "invalid-input");
}

async function qualifyExternalDeclaration({ root, put, invoke, main, compilerConfig }) {
  const externalDeclaration = "node_modules/@types/quality-fixture/index.d.ts";
  const externalTypeBytes = "interface QualityFixtureValue { readonly value: number; }\n";
  await put("node_modules/@types/quality-fixture/package.json", {
    name: "@types/quality-fixture", version: "1.0.0", types: "index.d.ts"
  });
  await put(externalDeclaration, externalTypeBytes);
  await put("config/production.json", {
    ...compilerConfig, compilerOptions: { ...compilerConfig.compilerOptions, types: ["quality-fixture"] }
  });
  await put(main, "export const value: QualityFixtureValue = { value: 1 };\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await rm(join(root, externalDeclaration));
  try {
    const missingExternalDeclaration = await invoke(["quality", "check"], 3);
    assert.equal(missingExternalDeclaration.outcome, "failed");
    assert.equal(missingExternalDeclaration.capabilities[0].diagnostics.length, 0);
  } finally {
    await put(externalDeclaration, externalTypeBytes);
  }
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put("config/production.json", compilerConfig);
  await put(main, "export const value: number = 1;\n");
  await rm(join(root, "node_modules/@types/quality-fixture"), { recursive: true });
}

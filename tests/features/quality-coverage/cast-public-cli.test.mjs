import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { copyPinnedToolchain } from "./copied-toolchain.mjs";

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const cli = join(repository, "packages/engineering-foundation/dist/cli.js");
const installedCli = join(repository, ".ef331-installed/node_modules/@agent-teams/engineering-foundation/dist/cli.js");

test("built public quality check rejects unknown chains and accepts exact evidence-bound bridges", async () => {
  const root = await mkdtemp(join(tmpdir(), "ef-331-public-quality-TEST-"));
  try {
    const put = async (path, value) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
    };
    const pins = await copyPinnedToolchain(root);
    await mkdir(join(root, "presets"));
    for (const name of ["base", "node", "type-aware", "maintainability"]) {
      await cp(join(repository, "packages/engineering-foundation/presets/oxlint", `${name}.json`),
        join(root, "presets", `${name}.json`));
    }
    const moduleRoot = "packages/worker";
    const sourceRoot = `${moduleRoot}/src`;
    const main = `${sourceRoot}/main.ts`;
    await put("package.json", { name: "ef-331-public-quality-TEST", private: true, type: "module",
      scripts: { "check:fast": "pnpm quality:scope", check: "pnpm lint:typed",
        "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
        "lint:typed": "agent-teams-foundation quality check --consumer ." },
      devDependencies: { "@agent-teams/engineering-foundation": "1.5.1", ...pins } });
    await put("pnpm-workspace.yaml", "packages: ['packages/*']\n");
    await put(`${moduleRoot}/package.json`, { name: "@fixture/worker", private: true, type: "module" });
    await put("config/production.json", { compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", types: [], noEmit: true },
      include: [`../${sourceRoot}/**/*.ts`] });
    await put("features.json", { schemaVersion: 1,
      standard: { id: "agent-teams.feature-module-standard", version: "v1" },
      productionRoots: ["packages"], applicationRoots: [], excludedRoots: [],
      topology: { sourcePolicy: "source.yaml" }, modules: [{ root: moduleRoot, sourceRoot, testRoots: [`${moduleRoot}/tests`] }] });
    await put("source.yaml", { schemaVersion: 3, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      packageRoots: ["packages"], governedRoots: [sourceRoot],
      boundaries: [{ id: "worker", roots: [sourceRoot], entrypoints: [main],
        allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } }] });
    await put("suppressions.yaml", { schemaVersion: 1, governedRoots: [sourceRoot], nonWaivableRulePrefixes: [], waivers: [] });
    await put("lint.json", { options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" },
      extends: ["./presets/type-aware.json", "./presets/maintainability.json"] });
    await put("quality.yaml", { schemaVersion: 1, sourcePolicyPath: "source.yaml", suppressionPolicyPath: "suppressions.yaml",
      featureProfilePath: "features.json", lintConfigPath: "lint.json", compilerProjects: ["config/production.json"],
      scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" } });
    await put("foundation.config.yaml", { schemaVersion: 2, project: { id: "ef-331-test" },
      capabilities: { "quality.source-coverage": { configPath: "quality.yaml" } } });
    const cast = 'interface Trusted { readonly marker: "trusted" }\nexport const value = "unsafe" as unknown as Trusted;\n';
    const invoke = async (entrypoint = cli, scopeOnly = false) => {
      try {
        const result = await promisify(execFile)(process.execPath,
          [entrypoint, "quality", "check", ...(scopeOnly ? ["--scope-only"] : []), "--consumer", root, "--format", "json"], { cwd: root, maxBuffer: 1024 * 1024 });
        return { code: 0, report: JSON.parse(result.stdout) };
      } catch (error) {
        return { code: error.code, report: JSON.parse(error.stdout) };
      }
    };
    await put(main, cast);
    const physicalOld = await realpath(dirname(installedCli));
    assert.match(physicalOld, /node_modules\/.*engineering-foundation\/dist$/u);
    const oldManifest = JSON.parse(await readFile(join(physicalOld, "../package.json"), "utf8"));
    assert.equal(oldManifest.version, "1.5.1");
    const old = await invoke(installedCli);
    assert.deepEqual({ code: old.code, outcome: old.report.outcome }, { code: 0, outcome: "passed" }, JSON.stringify(old.report));
    const unadmitted = await invoke();
    assert.equal(unadmitted.code, 1, JSON.stringify(unadmitted.report));
    assert.ok(unadmitted.report.capabilities[0].diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.explicit-unknown" && location.path === main));
    assert.equal((await invoke(cli, true)).code, 0);
    const tuple = 'export const value = [[1], [1, 2]].flat() as unknown as readonly [number, number, number];\n';
    await put(main, tuple);
    const chain = '[[1], [1, 2]].flat() as unknown as readonly [number, number, number]';
    const start = tuple.indexOf(chain);
    const bridge = { path: main, start, end: start + chain.length,
      sha256: createHash("sha256").update(chain).digest("hex"),
      rationale: "Array.flat preserves tuple order and duplicates; readonly is type only.",
      rejectingTest: "tests/bridge-rejection.test.mjs" };
    await put("tests/bridge-rejection.test.mjs", 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("flat tuple order and duplicates", () => {\n  assert.deepEqual([[1], [1, 2]].flat(), [1, 1, 2]);\n  assert.notDeepEqual([[1], [1, 2]].flat(), [1, 2]);\n});\n');
    await promisify(execFile)(process.execPath, ["--test", "tests/bridge-rejection.test.mjs"], { cwd: root });
    await put("bridges.json", { schemaVersion: 1, bridges: [bridge] });
    await put("quality.yaml", { schemaVersion: 1, sourcePolicyPath: "source.yaml", suppressionPolicyPath: "suppressions.yaml",
      featureProfilePath: "features.json", lintConfigPath: "lint.json", compilerProjects: ["config/production.json"],
      bridgeAdmissionsPath: "bridges.json",
      scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" } });
    assert.equal((await invoke()).code, 0);
    await put("bridges.json", { schemaVersion: 1, bridges: [bridge, bridge] });
    assert.equal((await invoke()).code, 2);
    await put("bridges.json", { schemaVersion: 1, bridges: [{ ...bridge, sha256: "0".repeat(64) }] });
    assert.equal((await invoke()).code, 2);
    await put("bridges.json", { schemaVersion: 1, bridges: [bridge] });
    const variants = [
      'type Alias = Trusted; export const value = (("unsafe" as /* bridge */ unknown)!) satisfies unknown as Alias;\n',
      'type Alias = Trusted; export const value = <Alias>(<unknown>"unsafe");\n'
    ];
    for (const variant of variants) {
      await put(main, `interface Trusted { readonly marker: "trusted" }\n${variant}`);
      assert.equal((await invoke()).code, 2); // The old exact record is stale.
      await put("bridges.json", { schemaVersion: 1, bridges: [] });
      const rejectedVariant = await invoke();
      assert.equal(rejectedVariant.code, 1, JSON.stringify(rejectedVariant.report));
      assert.ok(rejectedVariant.report.capabilities[0].diagnostics.some(({ ruleId }) => ruleId === "quality.source-coverage.explicit-unknown"));
      await put("bridges.json", { schemaVersion: 1, bridges: [bridge] });
    }
    await put("bridges.json", { schemaVersion: 1, bridges: [] });
    await put(main, 'interface Trusted { readonly marker: "trusted" }\nexport const value: Trusted = { marker: "trusted" };\nPromise.resolve(1);\n');
    const rejected = await invoke();
    assert.equal(rejected.code, 1);
    assert.ok(rejected.report.capabilities[0].diagnostics.some(({ location, evidence }) =>
      location.path === main && evidence.some(({ value }) => value === "typescript(no-floating-promises)")));
    await put(main, 'interface Trusted { readonly marker: "trusted" }\nexport const value: Trusted = { marker: "trusted" };\n');
    assert.equal((await invoke()).code, 0);
    await put("lint.json", { options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" },
      extends: ["./presets/type-aware.json", "./presets/maintainability.json"], jsPlugins: ["./plugin.mjs"] });
    const unsupportedPlugin = await invoke();
    assert.equal(unsupportedPlugin.code, 2);
    assert.match(JSON.stringify(unsupportedPlugin.report), /Executable Oxlint plugins are outside this qualified configuration form/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

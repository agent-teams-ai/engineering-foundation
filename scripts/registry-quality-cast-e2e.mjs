import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { copyPinnedToolchain } from "../tests/features/quality-coverage/copied-toolchain.mjs";
import { runCommand } from "./pack-test-support.mjs";

/** Qualify the public cast gate in the consumer's verified registry installation. */
export async function verifyRegistryQualityCast({ consumerRoot, installedRoot }) {
  const physicalConsumer = await realpath(consumerRoot);
  const physicalFoundation = await realpath(installedRoot);
  assert.equal(physicalFoundation, await realpath(join(
    physicalConsumer, "node_modules/@agent-teams/engineering-foundation",
  )), "Cast fixture must use the verified registry installation");
  const cli = join(physicalFoundation, "dist/cli.js");
  const installedCliBytes = await readFile(cli);
  const pins = await copyPinnedToolchain(physicalConsumer);
  assert.ok((await readFile(cli)).equals(installedCliBytes),
    "Pinned tools must preserve the verified registry CLI bytes");
  assert.equal(await realpath(join(physicalConsumer, "node_modules/@agent-teams/engineering-foundation")),
    physicalFoundation, "Pinned tools must preserve the registry-installed Foundation package");
  const put = async (path, value) => {
    const target = join(physicalConsumer, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const moduleRoot = "packages/worker";
  const sourceRoot = `${moduleRoot}/src`;
  const main = `${sourceRoot}/main.ts`;
  const manifest = JSON.parse(await readFile(join(physicalConsumer, "package.json"), "utf8"));
  await put("package.json", { ...manifest, scripts: {
    ...manifest.scripts,
    "check:fast": "pnpm quality:scope", check: "pnpm lint:typed",
    "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
    "lint:typed": "agent-teams-foundation quality check --consumer .",
  }, devDependencies: { ...manifest.devDependencies, ...pins } });
  await put("pnpm-workspace.yaml", "packages: ['packages/*']\n");
  await put(`${moduleRoot}/package.json`, { name: "@fixture/worker", private: true, type: "module" });
  await put("config/production.json", {
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", types: [], noEmit: true },
    include: [`../${sourceRoot}/**/*.ts`],
  });
  await put("features.json", {
    schemaVersion: 1, standard: { id: "agent-teams.feature-module-standard", version: "v1" },
    productionRoots: ["packages"], applicationRoots: [], excludedRoots: [],
    topology: { sourcePolicy: "source.yaml" },
    modules: [{ root: moduleRoot, sourceRoot, testRoots: [`${moduleRoot}/tests`] }],
  });
  await put("source.yaml", {
    schemaVersion: 3, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: ["packages"], governedRoots: [sourceRoot],
    boundaries: [{ id: "worker", roots: [sourceRoot], entrypoints: [main],
      allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } }],
  });
  await put("suppressions.yaml", {
    schemaVersion: 1, governedRoots: [sourceRoot], nonWaivableRulePrefixes: [], waivers: [],
  });
  await put("lint.json", {
    options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" },
    extends: [
      "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/type-aware.json",
      "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/maintainability.json",
    ],
  });
  const quality = {
    schemaVersion: 1, sourcePolicyPath: "source.yaml", suppressionPolicyPath: "suppressions.yaml",
    featureProfilePath: "features.json", lintConfigPath: "lint.json",
    compilerProjects: ["config/production.json"],
    scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" },
  };
  await put("quality.yaml", quality);
  await put("foundation.config.yaml", { schemaVersion: 2, project: { id: "registry-cast" },
    capabilities: { "quality.source-coverage": { configPath: "quality.yaml" } } });
  const invoke = async (expectedCode) => {
    let result;
    try {
      result = { code: 0, ...await runCommand(process.execPath,
        [cli, "quality", "check", "--consumer", physicalConsumer, "--format", "json"], physicalConsumer) };
    } catch (error) { result = error; }
    assert.equal(result.code, expectedCode, result.stdout || result.stderr || result.message);
    return JSON.parse(result.stdout);
  };
  const parser = `export function parsePair(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("Expected two finite numbers");
  }
  const first: unknown = value[0];
  const second: unknown = value[1];
  if (typeof first !== "number" || !Number.isFinite(first) ||
      typeof second !== "number" || !Number.isFinite(second)) {
    throw new TypeError("Expected two finite numbers");
  }
  return value as unknown as readonly [number, number];
}
`;
  await put(main, parser);
  const rejected = await invoke(1);
  assert.equal(rejected.outcome, "violations");
  assert.ok(rejected.capabilities[0].diagnostics.some(({ ruleId, location }) =>
    ruleId === "quality.source-coverage.explicit-unknown" && location.path === main));
  await put("tests/pair-rejection.test.mjs", `import assert from "node:assert/strict";
import test from "node:test";
import { parsePair } from "../${main}";
test("parsePair admits only two finite numbers", () => {
  assert.deepEqual(parsePair([1, 2]), [1, 2]);
  for (const malformed of [[1], [1, 2, 3], [1, "2"], ["1", 2], [1, NaN], null]) {
    assert.throws(() => parsePair(malformed), TypeError);
  }
});
`);
  await runCommand(process.execPath, ["--test", "tests/pair-rejection.test.mjs"], physicalConsumer);
  const expression = "value as unknown as readonly [number, number]";
  const start = parser.indexOf(expression);
  assert.ok(start >= 0);
  await put("bridges.json", { schemaVersion: 1, bridges: [{ path: main, start,
    end: start + expression.length, sha256: createHash("sha256").update(expression).digest("hex"),
    rationale: "The parser checks exact length and finite numeric element types before this tuple assertion.",
    rejectingTest: "tests/pair-rejection.test.mjs" }] });
  await put("quality.yaml", { ...quality, bridgeAdmissionsPath: "bridges.json" });
  assert.equal((await invoke(0)).outcome, "passed");
}

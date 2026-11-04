import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import {
  runQualityCli,
  qualityReport,
  type QualityFixturePut,
  type QualityFixtureProfile,
} from "./quality-cli-fixture.ts";
import { copyPinnedToolchain } from "./copied-toolchain.mjs";

export const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
export const cli = join(repository, "packages/engineering-foundation/dist/cli.js");

export async function governedDistFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ef-governed-dist-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put: QualityFixturePut = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const pins = await copyPinnedToolchain(root);
  await put("package.json", {
    name: "governed-dist-test",
    private: true,
    type: "module",
    scripts: {
      "check:fast": "pnpm quality:scope",
      check: "pnpm lint:typed",
      "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
      "lint:typed": "agent-teams-foundation quality check --consumer .",
    },
    devDependencies: { "@agent-teams/engineering-foundation": "1.7.0", ...pins },
  });
  await put("pnpm-workspace.yaml", "packages: ['packages/*']\n");
  await put("packages/worker/package.json", {
    name: "@fixture/worker",
    private: true,
    type: "module",
  });
  await put("packages/worker/src/main.ts", "export const value = 1;\n");
  await put("packages/worker/src/baseline.mjs", "export const javascriptValue = 1;\n");
  await put("config/production.json", {
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      types: [],
      noEmit: true,
    },
    include: ["../packages/worker/src/**/*.ts", "../packages/worker/dist/**/*.ts"],
  });
  await put("suppressions.yaml", {
    schemaVersion: 1,
    governedRoots: ["packages/worker/src", "packages/worker/dist"],
    nonWaivableRulePrefixes: [],
    waivers: [],
  });
  await put("lint.json", {
    options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" },
    extends: [
      "./node_modules/stack-toolchain/presets/oxlint/type-aware.json",
      "./node_modules/stack-toolchain/presets/oxlint/maintainability.json",
    ],
  });
  await put("toolchain.config.json", { typecheck: { projects: ["config/production.json"] } });
  await put("quality.yaml", {
    schemaVersion: 5,
    budgetMs: 120000,
    sourcePolicyPath: "source.yaml",
    suppressionPolicyPath: "suppressions.yaml",
    topologyPath: "topology.json",
    lintConfigPath: "lint.json",
    toolchainConfigPath: "toolchain.config.json",
    scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" },
  });
  await put("foundation.config.yaml", {
    schemaVersion: 2,
    project: { id: "governed-dist-test" },
    capabilities: {
      "quality.source-coverage": { configPath: "quality.yaml" },
      "architecture.source-dependencies": { configPath: "source.yaml" },
    },
  });
  const invoke = async (route: readonly string[] = ["quality", "check"]) => {
    const result = await runQualityCli(cli, root, route);
    return {
      code: result.code,
      stdout: result.stdout,
      report: qualityReport(
        result.stdout,
        route[0] === "check" ? route[1] : "quality.source-coverage",
      ),
    };
  };
  return { root, put, invoke };
}

export async function preparePublicCastFixture(root: string, put: QualityFixturePut) {
  const pins = await copyPinnedToolchain(root);
  await mkdir(join(root, "presets"));
  for (const name of ["base", "node", "type-aware", "maintainability"]) {
    await cp(
      join(repository, "packages/stack-toolchain/presets/oxlint", `${name}.json`),
      join(root, "presets", `${name}.json`),
    );
  }
  const moduleRoot = "packages/worker";
  const sourceRoot = `${moduleRoot}/src`;
  const main = `${sourceRoot}/main.ts`;
  await put("package.json", {
    name: "ef-331-public-quality-TEST",
    private: true,
    type: "module",
    scripts: {
      "check:fast": "pnpm quality:scope",
      check: "pnpm lint:typed",
      "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
      "lint:typed": "agent-teams-foundation quality check --consumer .",
    },
    devDependencies: { "@agent-teams/engineering-foundation": "1.5.1", ...pins },
  });
  await put("pnpm-workspace.yaml", "packages: ['packages/*']\n");
  await put(`${moduleRoot}/package.json`, {
    name: "@fixture/worker",
    private: true,
    type: "module",
  });
  await put("config/production.json", {
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      types: [],
      noEmit: true,
    },
    include: [`../${sourceRoot}/**/*.ts`],
  });
  await put("topology.json", {
    schemaVersion: 1,
    censusRoots: ["packages"],
    packageRoots: [".", moduleRoot],
    sourceRoots: [sourceRoot],
    testRoots: [`${moduleRoot}/tests`],
    excludedRoots: [],
    toolingFiles: [],
  });
  await put("source.yaml", {
    schemaVersion: 3,
    workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: ["packages"],
    governedRoots: [sourceRoot],
    boundaries: [
      {
        id: "worker",
        roots: [sourceRoot],
        entrypoints: [main],
        allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
      },
    ],
  });
  await put("suppressions.yaml", {
    schemaVersion: 1,
    governedRoots: [sourceRoot],
    nonWaivableRulePrefixes: [],
    waivers: [],
  });
  await put("lint.json", {
    options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" },
    extends: [
      "./node_modules/stack-toolchain/presets/oxlint/type-aware.json",
      "./node_modules/stack-toolchain/presets/oxlint/maintainability.json",
    ],
  });
  await put("toolchain.config.json", { typecheck: { projects: ["config/production.json"] } });
  const profile = {
    schemaVersion: 5,
    budgetMs: 120000,
    sourcePolicyPath: "source.yaml",
    suppressionPolicyPath: "suppressions.yaml",
    topologyPath: "topology.json",
    lintConfigPath: "lint.json",
    toolchainConfigPath: "toolchain.config.json",
    scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" },
  } satisfies QualityFixtureProfile;
  await put("quality.yaml", profile);
  await put("foundation.config.yaml", {
    schemaVersion: 2,
    project: { id: "ef-331-test" },
    capabilities: { "quality.source-coverage": { configPath: "quality.yaml" } },
  });
  return { main, sourceRoot, profile };
}

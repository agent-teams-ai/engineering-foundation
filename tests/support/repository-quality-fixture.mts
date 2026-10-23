import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyPinnedToolchain } from "../features/quality-coverage/copied-toolchain.mjs";

/** Finite real-quality consumer fixture; copies pinned local tools without installs. */
async function writeRepositoryQualityFixture(root: string, repositoryRoot: string): Promise<void> {
  const put = async (path: string, value: unknown) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const pins = await copyPinnedToolchain(root);
  for (const name of ["base", "node", "type-aware", "maintainability"]) {
    await put(`presets/${name}.json`, await readFile(
      join(repositoryRoot, "packages/stack-toolchain/presets/oxlint", `${name}.json`), "utf8"));
  }
  await put("package.json", { name: "test-bun-quality-binding", private: true, type: "module",
    packageManager: "bun@1.4.3",
    scripts: { "check:fast": "pnpm quality:scope", check: "pnpm lint:typed",
      "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
      "lint:typed": "agent-teams-foundation quality check --consumer ." },
    devDependencies: { "@agent-teams/engineering-foundation": "1.9.0", ...pins } });
  await put("pnpm-workspace.yaml", "packages: ['packages/*']\n");
  await put("packages/worker/package.json", { name: "@fixture/worker", private: true, type: "module" });
  await put("packages/worker/src/main.ts", "export const value = 1;\n");
  await put("config/production.json", { compilerOptions: { strict: true, target: "ES2022",
    module: "NodeNext", types: [], noEmit: true }, include: ["../packages/worker/src/**/*.ts"] });
  await put("suppressions.yaml", { schemaVersion: 1, governedRoots: ["packages/worker/src"],
    nonWaivableRulePrefixes: [], waivers: [] });
  await put("lint.json", { options: { respectEslintDisableDirectives: false,
    reportUnusedDisableDirectives: "error" }, extends: ["./presets/type-aware.json", "./presets/maintainability.json"] });
  await put("source.yaml", { schemaVersion: 2, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: ["packages"], governedRoots: ["packages/worker/src"], boundaries: [{ id: "worker",
      roots: ["packages/worker/src"], entrypoints: ["packages/worker/src/main.ts"],
      allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } }] });
  await put("features.json", { schemaVersion: 1,
    standard: { id: "agent-teams.feature-module-standard", version: "v1" }, productionRoots: ["packages"],
    applicationRoots: [], excludedRoots: [], topology: { sourcePolicy: "source.yaml" },
    modules: [{ root: "packages/worker", sourceRoot: "packages/worker/src", testRoots: ["packages/worker/tests"] }] });
  await put("quality.yaml", { schemaVersion: 1, sourcePolicyPath: "source.yaml", suppressionPolicyPath: "suppressions.yaml",
    featureProfilePath: "features.json", lintConfigPath: "lint.json", compilerProjects: ["config/production.json"],
    scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" } });
  await put("foundation.config.yaml", { schemaVersion: 2, project: { id: "test-bun-quality-binding" },
    capabilities: { "quality.source-coverage": { configPath: "quality.yaml" },
      "architecture.source-dependencies": { configPath: "source.yaml" } } });
}

/** Explicit installed-preset variant; leaves existing fixture callers unchanged. */
export async function writeInstalledRepositoryQualityFixture(root: string, repositoryRoot: string): Promise<void> {
  await writeRepositoryQualityFixture(root, repositoryRoot);
  const lintPath = join(root, "lint.json");
  const lint = JSON.parse(await readFile(lintPath, "utf8")) as { extends: string[] };
  lint.extends = [
    "./node_modules/stack-toolchain/presets/oxlint/type-aware.json",
    "./node_modules/stack-toolchain/presets/oxlint/maintainability.json"
  ];
  await writeFile(lintPath, JSON.stringify(lint));
  await writeFile(join(root, "packages/worker/src/baseline.mjs"), "export const baseline = 1;\n");
}

/** Second-phase fixture script records the dispatcher's admitted runtime bindings. */
export async function writeRuntimeBindingObservationFixture(root: string): Promise<void> {
  await writeFile(join(root, "observe.mts"), [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("runtime-binding.json", JSON.stringify({',
    'node: process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"],',
    'bun: process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"],',
    'leafNodeVersion: process.versions.node }));'
  ].join("\n"));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  manifest.scripts["check"] = "node observe.mts";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
}

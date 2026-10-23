export type FixturePut = (path: string, value: unknown) => Promise<void>;
export async function writeQualityLayout({
  nested,
  devDependencies,
  put,
}: {
  nested: boolean;
  devDependencies: Record<string, string>;
  put: FixturePut;
}) {
  const moduleRoot = nested ? "packages/contexts/private-worker" : "packages/worker";
  const packageContainer = nested ? "packages/contexts" : "packages";
  const sourceRoot = `${moduleRoot}/src`;
  const nativeRoot = `${moduleRoot}/native`;
  const governedRoots = nested ? [sourceRoot, nativeRoot] : [sourceRoot];
  const main = `${sourceRoot}/main.ts`;
  const scripts = {
    "check:fast": "pnpm quality:scope",
    check: nested ? "pnpm lint:typed && pnpm native:check" : "pnpm lint:typed",
    ...(nested ? { "native:check": "node scripts/check-native.mjs" } : {}),
    "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
    "lint:typed": "agent-teams-foundation quality check --consumer .",
  };
  await put("package.json", {
    name: "quality-packed-consumer",
    private: true,
    type: "module",
    scripts,
    devDependencies,
  });
  await put("pnpm-workspace.yaml", `packages: ['${packageContainer}/*']\n`);
  await put(`${moduleRoot}/package.json`, {
    name: "@fixture/private-worker",
    private: true,
    type: "module",
  });
  await put(main, "export const value = 1;\n");
  if (nested) {
    await put(`${nativeRoot}/helper.c`, "int helper(void) { return 0; }\n");
    await put(`${nativeRoot}/helper.h`, "int helper(void);\n");
    await put(
      "scripts/check-native.mjs",
      "throw new Error('native execution is consumer-owned');\n",
    );
  }
  await put(`${sourceRoot}/owned.d.ts`, "export declare const declared: number;\n");
  await put(`${sourceRoot}/owned.d.mts`, "export declare const moduleDeclared: number;\n");
  await put(`${sourceRoot}/build.mjs`, "export const build = () => 1;\n");
  await put("config/production.json", {
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      types: [],
      noEmit: true,
    },
    include: [`../${sourceRoot}/**/*.ts`, `../${sourceRoot}/**/*.d.mts`],
  });
  await put(
    "features.json",
    nested
      ? {
          schemaVersion: 1,
          authority: { id: "agent-teams.feature-module-standard", version: "v1" },
          scope: {
            workspaceContainers: [packageContainer],
            productionModules: [{ moduleRoot, sourceRoot }],
          },
          adoption: {
            applicationRoots: [],
            excludedRoots: [],
            abstractLayout: {
              modules: [{ moduleRoot, sourceRoot, testRoot: `${moduleRoot}/tests` }],
              applications: [],
            },
          },
        }
      : {
          schemaVersion: 1,
          standard: { id: "agent-teams.feature-module-standard", version: "v1" },
          productionRoots: [packageContainer],
          applicationRoots: [],
          excludedRoots: [],
          topology: { sourcePolicy: "source.yaml" },
          modules: [{ root: moduleRoot, sourceRoot, testRoots: [`${moduleRoot}/tests`] }],
        },
  );
  await put("source.yaml", {
    schemaVersion: 3,
    workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: [packageContainer],
    governedRoots,
    boundaries: [
      {
        id: "worker",
        roots: governedRoots,
        entrypoints: [main],
        allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
      },
    ],
  });
  await put("suppressions.yaml", {
    schemaVersion: 1,
    governedRoots,
    nonWaivableRulePrefixes: [],
    waivers: [],
  });
  await put("toolchain.config.json", {
    schemaVersion: 1,
    profile: "typescript-node",
    typecheck: { projects: ["config/production.json"] },
    lint: { config: "lint.json", paths: [sourceRoot] },
    format: { paths: [sourceRoot] },
  });
  await put("lint.json", {
    options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" },
    extends: [
      "./node_modules/stack-toolchain/presets/oxlint/type-aware.json",
      "./node_modules/stack-toolchain/presets/oxlint/maintainability.json",
    ],
  });
  await put("quality.yaml", {
    schemaVersion: 4,
    sourcePolicyPath: "source.yaml",
    suppressionPolicyPath: "suppressions.yaml",
    featureProfilePath: "features.json",
    lintConfigPath: "lint.json",
    toolchainConfigPath: "toolchain.config.json",
    ...(nested ? { nativeChecks: [{ boundaryId: "worker", script: "native:check" }] } : {}),
    scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" },
  });
  const activation = {
    schemaVersion: 2,
    project: { id: "packed-quality" },
    capabilities: {
      "quality.source-coverage": { configPath: "quality.yaml" },
    },
  };
  await put("foundation.config.yaml", activation);
  return { moduleRoot, sourceRoot, main, scripts, activation };
}

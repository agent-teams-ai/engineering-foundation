export type FixturePut = (path: string, value: unknown) => Promise<void>;
export async function writeQualityLayout({
  nested,
  rootPackage = false,
  devDependencies,
  put,
}: {
  nested: boolean;
  rootPackage?: boolean;
  devDependencies: Record<string, string>;
  put: FixturePut;
}) {
  const moduleRoot = rootPackage
    ? "."
    : nested
      ? "packages/contexts/private-worker"
      : "packages/worker";
  const packageContainer = nested ? "packages/contexts" : "packages";
  const sourceRoot = rootPackage ? "src" : `${moduleRoot}/src`;
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
  await put(
    "pnpm-workspace.yaml",
    rootPackage ? "packages: []\n" : `packages: ['${packageContainer}/*']\n`,
  );
  if (!rootPackage) {
    await put(`${moduleRoot}/package.json`, {
      name: "@fixture/private-worker",
      private: true,
      type: "module",
    });
  }
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
  await put("topology.json", {
    schemaVersion: 1,
    censusRoots: rootPackage ? ["."] : [packageContainer],
    packageRoots: rootPackage ? ["."] : [".", moduleRoot],
    sourceRoots: governedRoots,
    testRoots: [rootPackage ? "tests" : `${moduleRoot}/tests`],
    excludedRoots: [],
    toolingFiles: [],
  });
  await put("source.yaml", {
    schemaVersion: 3,
    workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: rootPackage ? [] : [packageContainer],
    ...(rootPackage ? { rootPackage: true } : {}),
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
    schemaVersion: 5,
    budgetMs: 120000,
    sourcePolicyPath: "source.yaml",
    suppressionPolicyPath: "suppressions.yaml",
    topologyPath: "topology.json",
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

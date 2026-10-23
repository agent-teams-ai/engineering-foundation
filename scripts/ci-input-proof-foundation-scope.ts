import type { ScopeCategory } from "./ci-input-proof-foundation-adapter.mts";
export type ScopeInput = Readonly<{ logicalPath: string; sourcePath: string | null }>;
type Scope = Readonly<Record<ScopeCategory, readonly ScopeInput[]>>;

export const scope: Scope = Object.freeze({
  source: Object.freeze([
    {
      logicalPath: "packages/ci-input-proof/src/index.ts",
      sourcePath: "packages/ci-input-proof/src/index.ts",
    },
    {
      logicalPath:
        "packages/ci-input-proof/src/features/input-comparison/application/compare-leaf-inventories.ts",
      sourcePath:
        "packages/ci-input-proof/src/features/input-comparison/application/compare-leaf-inventories.ts",
    },
  ]),
  helpers: Object.freeze([
    ...[
      "scripts/ci-input-proof-foundation-types.ts",
      "scripts/ci-input-proof-foundation-scope.ts",
    ].map((path) => ({ logicalPath: path, sourcePath: path })),
    {
      logicalPath: "scripts/ci-input-proof-full.mts",
      sourcePath: "scripts/ci-input-proof-full.mts",
    },
    {
      logicalPath: "scripts/ci-input-proof-foundation-adapter.mts",
      sourcePath: "scripts/ci-input-proof-foundation-adapter.mts",
    },
    {
      logicalPath: "scripts/ci-input-proof-foundation-pilot.mts",
      sourcePath: "scripts/ci-input-proof-foundation-pilot.mts",
    },
    {
      logicalPath: "scripts/packed-ci-input-proof.mts",
      sourcePath: "scripts/packed-ci-input-proof.mts",
    },
    {
      logicalPath: "scripts/ci-input-proof-packed-harness.mts",
      sourcePath: "scripts/ci-input-proof-packed-harness.mts",
    },
    { logicalPath: "scripts/pack-test.mjs", sourcePath: "scripts/pack-test.mjs" },
    {
      logicalPath: "scripts/prepare-ci-input-proof-rc.mts",
      sourcePath: "scripts/prepare-ci-input-proof-rc.mts",
    },
    {
      logicalPath: "tests/support/ci-input-proof-donor-cases.mts",
      sourcePath: "tests/support/ci-input-proof-donor-cases.mts",
    },
    {
      logicalPath: "tests/support/ci-input-proof-adapter-fixtures.mts",
      sourcePath: "tests/support/ci-input-proof-adapter-fixtures.mts",
    },
  ]),
  fixtures: Object.freeze([
    {
      logicalPath: "tests/features/input-comparison/ci-input-proof.test.mts",
      sourcePath: "tests/features/input-comparison/ci-input-proof.test.mts",
    },
    {
      logicalPath: "tests/features/input-comparison/ci-input-proof-process.test.mts",
      sourcePath: "tests/features/input-comparison/ci-input-proof-process.test.mts",
    },
    {
      logicalPath: "tests/ci-input-proof-rc.test.mts",
      sourcePath: "tests/ci-input-proof-rc.test.mts",
    },
    {
      logicalPath: "tests/fixtures/ci-input-proof/ci-input-proof-kernel.TEST.md",
      sourcePath: "tests/fixtures/ci-input-proof/ci-input-proof-kernel.TEST.md",
    },
    {
      logicalPath: "tests/fixtures/ci-input-proof/foundation-pilot.TEST.mts",
      sourcePath: "tests/fixtures/ci-input-proof/foundation-pilot.TEST.mts",
    },
  ]),
  config: Object.freeze([
    { logicalPath: ".changeset/config.json", sourcePath: ".changeset/config.json" },
    {
      logicalPath: "architecture/foundation/feature-modules.json",
      sourcePath: "architecture/foundation/feature-modules.json",
    },
    { logicalPath: "foundation.config.yaml", sourcePath: "foundation.config.yaml" },
    { logicalPath: "LICENSE", sourcePath: "LICENSE" },
    {
      logicalPath: "packages/ci-input-proof/CHANGELOG.md",
      sourcePath: "packages/ci-input-proof/CHANGELOG.md",
    },
    {
      logicalPath: "packages/ci-input-proof/LICENSE",
      sourcePath: "packages/ci-input-proof/LICENSE",
    },
    {
      logicalPath: "packages/ci-input-proof/README.md",
      sourcePath: "packages/ci-input-proof/README.md",
    },
    {
      logicalPath: "packages/ci-input-proof/tsconfig.json",
      sourcePath: "packages/ci-input-proof/tsconfig.json",
    },
    {
      logicalPath: "tests/manifests/test-shards.v1.json",
      sourcePath: "tests/manifests/test-shards.v1.json",
    },
    {
      logicalPath: "tests/manifests/windows-lanes.v1.json",
      sourcePath: "tests/manifests/windows-lanes.v1.json",
    },
    { logicalPath: "tsconfig.json", sourcePath: "tsconfig.json" },
    { logicalPath: "tsconfig.ci-tooling.json", sourcePath: "tsconfig.ci-tooling.json" },
  ]),
  lock: Object.freeze([
    { logicalPath: "package.json", sourcePath: "package.json" },
    { logicalPath: "pnpm-lock.yaml", sourcePath: "pnpm-lock.yaml" },
    { logicalPath: "pnpm-workspace.yaml", sourcePath: "pnpm-workspace.yaml" },
  ]),
  toolchain: Object.freeze([
    { logicalPath: ".node-version", sourcePath: ".node-version" },
    { logicalPath: ".npmrc", sourcePath: ".npmrc" },
    { logicalPath: "toolchain/node-executable", sourcePath: null },
    { logicalPath: "toolchain/runtime-facts", sourcePath: null },
  ]),
  installedGraph: Object.freeze([
    { logicalPath: "node_modules/.package-map.json", sourcePath: "node_modules/.package-map.json" },
    { logicalPath: "node_modules/.pnpm/lock.yaml", sourcePath: "node_modules/.pnpm/lock.yaml" },
    {
      logicalPath: "packages/ci-input-proof/package.json",
      sourcePath: "packages/ci-input-proof/package.json",
    },
    {
      logicalPath: "packages/ci-input-proof/dist/index.js",
      sourcePath: "packages/ci-input-proof/dist/index.js",
    },
    {
      logicalPath: "packages/ci-input-proof/dist/index.d.ts",
      sourcePath: "packages/ci-input-proof/dist/index.d.ts",
    },
    {
      logicalPath: "packages/ci-input-proof/dist/index.js.map",
      sourcePath: "packages/ci-input-proof/dist/index.js.map",
    },
    {
      logicalPath: "packages/ci-input-proof/dist/index.d.ts.map",
      sourcePath: "packages/ci-input-proof/dist/index.d.ts.map",
    },
    {
      logicalPath:
        "packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.js",
      sourcePath:
        "packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.js",
    },
    {
      logicalPath:
        "packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.d.ts",
      sourcePath:
        "packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.d.ts",
    },
    {
      logicalPath:
        "packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.js.map",
      sourcePath:
        "packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.js.map",
    },
    {
      logicalPath:
        "packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.d.ts.map",
      sourcePath:
        "packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.d.ts.map",
    },
  ]),
});

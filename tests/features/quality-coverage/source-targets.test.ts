import assert from "node:assert/strict";
import test from "node:test";
import { qualitySourceTargets } from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";

const topology = {
  schemaVersion: 1 as const,
  censusRoots: ["packages", "apps"],
  packageRoots: [".", "packages/core", "apps/web"],
  sourceRoots: ["packages/core/src", "apps/web/src"],
  excludedRoots: [],
  testRoots: [],
  toolingFiles: [],
};

void test("quality source targets retain supported files inside production source roots", () => {
  assert.deepEqual(
    qualitySourceTargets(
      [
        "packages/core/src/z.mjs",
        "packages/core/src/a.ts",
        "apps/web/src/main.d.mts",
        "packages/core/src/readme.md",
      ],
      { ...topology, toolingFiles: ["packages/core/src/z.mjs"] },
      { workspaceManifestPath: "pnpm-workspace.yaml", boundaries: [] },
    ),
    ["apps/web/src/main.d.mts", "packages/core/src/a.ts", "packages/core/src/z.mjs"],
  );
});

void test("quality source targets reject non-source files and paths outside production roots", () => {
  assert.deepEqual(
    qualitySourceTargets(
      [
        "packages/core/test/fixture.ts",
        "packages/core/src/types.d.ts",
        "packages/core/src/native.c",
        "apps/web/config.ts",
        "scripts/build.mjs",
        "packages/core/src/note.md",
      ],
      topology,
      { workspaceManifestPath: "pnpm-workspace.yaml", boundaries: [] },
    ),
    ["packages/core/src/types.d.ts"],
  );
});

void test("quality source targets retain runtime-owned adapters outside source roots", () => {
  const authority = {
    workspaceManifestPath: "pnpm-workspace.yaml",
    boundaries: [{ id: "adapter", dependencyMode: "runtime" as const, roots: ["adapters"] }],
  };
  assert.deepEqual(
    qualitySourceTargets(
      ["adapters/owned.mjs", "adapters/tool.mjs", "scripts/build.mjs"],
      { ...topology, toolingFiles: ["adapters/tool.mjs"] },
      authority,
    ),
    ["adapters/owned.mjs"],
  );
});

void test("raw census targets exclude nested tests even with runtime ownership", () => {
  const roots = {
    ...topology,
    excludedRoots: ["packages/core/src/tests/generated"],
    testRoots: ["packages/core/src/tests"],
  };
  const authority = {
    workspaceManifestPath: "pnpm-workspace.yaml",
    boundaries: [{ id: "core", dependencyMode: "runtime" as const, roots: ["packages/core/src"] }],
  };
  assert.deepEqual(
    qualitySourceTargets(
      [
        "packages/core/src/main.ts",
        "packages/core/src/tests/fixture.ts",
        "packages/core/src/tests/generated/fixture.ts",
      ],
      roots,
      authority,
    ),
    ["packages/core/src/main.ts"],
  );
});

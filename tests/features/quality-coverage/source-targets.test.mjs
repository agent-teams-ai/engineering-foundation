import assert from "node:assert/strict";
import test from "node:test";
import { qualitySourceTargets } from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";

const topology = { productionRoots: ["packages"], applicationRoots: ["apps"], productionSourceRoots: ["packages/core/src", "apps/web/src"], excludedRoots: [], modules: [] };

test("quality source targets retain supported files inside production source roots", () => {
  assert.deepEqual(qualitySourceTargets([
    "packages/core/src/z.mjs", "packages/core/src/a.ts", "apps/web/src/main.d.mts", "packages/core/src/readme.md"
  ], topology, { boundaries: [] }), ["apps/web/src/main.d.mts", "packages/core/src/a.ts", "packages/core/src/z.mjs"]);
});

test("quality source targets reject non-source files and paths outside production roots", () => {
  assert.deepEqual(qualitySourceTargets([
    "packages/core/test/fixture.ts", "packages/core/src/types.d.ts", "packages/core/src/native.c",
    "apps/web/config.ts", "scripts/build.mjs", "packages/core/src/note.md"
  ], topology, { boundaries: [] }), ["packages/core/src/types.d.ts"]);
});

test("quality source targets retain runtime-owned adapters outside source roots", () => {
  const authority = { boundaries: [{ id: "adapter", dependencyMode: "runtime", roots: ["adapters"] }] };
  assert.deepEqual(qualitySourceTargets(["adapters/owned.mjs", "adapters/tool.mjs", "scripts/build.mjs"], { ...topology, toolingFiles: ["adapters/tool.mjs"] }, authority), ["adapters/owned.mjs"]);
});

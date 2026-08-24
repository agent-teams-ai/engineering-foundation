import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NodeProcessRunner as LegacyNodeProcessRunner } from "../packages/engineering-foundation/dist/local-mode/index.js";
import { NodeProcessRunner } from "../packages/engineering-foundation/dist/mutation/qualification/index.js";

const sourceRoot = new URL("../packages/engineering-foundation/src/", import.meta.url);

test("publishes one canonical repository-mutation qualification facade", async () => {
  assert.equal(NodeProcessRunner, LegacyNodeProcessRunner);

  const manifest = JSON.parse(
    await readFile(new URL("../packages/engineering-foundation/package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest.exports["./mutation/qualification"], {
    types: "./dist/mutation/qualification/index.d.ts",
    import: "./dist/mutation/qualification/index.js",
  });

  const facade = await readFile(new URL("mutation/qualification/index.ts", sourceRoot), "utf8");
  assert.match(facade, /export \{ NodeProcessRunner \}/u);
  assert.match(facade, /KnownFileRecoveryFaultInjector/u);
  assert.match(facade, /KnownFileTransactionFaultInjector/u);
});

test("retains reviewed aliases with explicit migration deprecations", async () => {
  const [root, localMode, mutation, authoring] = await Promise.all([
    readFile(new URL("index.ts", sourceRoot), "utf8"),
    readFile(new URL("local-mode/index.ts", sourceRoot), "utf8"),
    readFile(new URL("mutation/index.ts", sourceRoot), "utf8"),
    readFile(new URL("document-authoring/index.ts", sourceRoot), "utf8"),
  ]);

  assert.match(root, /@deprecated[^\n]*local-mode/u);
  assert.match(root, /@deprecated[^\n]*mutation/u);
  assert.match(localMode, /@deprecated[\s\S]*NodeProcessRunner/u);
  assert.match(mutation, /@deprecated[\s\S]*KnownFileRecoveryFaultInjector/u);
  assert.match(mutation, /@deprecated[\s\S]*KnownFileTransactionFaultInjector/u);
  assert.match(authoring, /@deprecated[\s\S]*DocumentParentMaterializationPlanV2/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { repositoryRoot, validateTestManifestData, validateTestManifests } from "../scripts/check-test-manifests.mjs";

type Shard = { id: string; tests: string[] };
type ShardManifest = { schemaVersion: number; source: { runId: number; headSha: string; strategy: string }; shards: Shard[] };

// Ignoring a TS entry or omitting it from the blocking shard must reject the inventory.
test("TypeScript test entries are discovered and require exactly one blocking shard", async () => {
  const manifest = await validateTestManifests();
  const path = "tests/local-mode-boundaries-graph.test.mts";
  assert.ok(manifest.tests.includes(path));
  const shardManifest = JSON.parse(await readFile(join(repositoryRoot, "tests/manifests/test-shards.v1.json"), "utf8")) as ShardManifest;
  const coverageManifest: unknown = JSON.parse(await readFile(join(repositoryRoot, "tests/manifests/coverage.v1.json"), "utf8"));

  const missing = structuredClone(shardManifest);
  for (const shard of missing.shards) { shard.tests = shard.tests.filter(file => file !== path); }
  assert.throws(() => validateTestManifestData({
    shardManifest: missing, coverageManifest, testPaths: manifest.tests,
  }), /shard union differs.*local-mode-boundaries-graph\.test\.mts/u);

  const duplicate = structuredClone(shardManifest);
  const other = duplicate.shards.find(shard => !shard.tests.includes(path));
  assert.ok(other);
  other.tests.push(path);
  assert.throws(() => validateTestManifestData({
    shardManifest: duplicate, coverageManifest, testPaths: manifest.tests,
  }), /assigned more than once/u);
});

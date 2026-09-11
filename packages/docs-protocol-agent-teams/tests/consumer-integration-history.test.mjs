import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPackageConsumerAssetCatalog } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import { CANONICAL_TRANSITION_CATALOG } from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;


test("stable18 and stable19 history bind exact generation2 authority and immutable assets", async () => {
  const catalog = JSON.parse(CANONICAL_TRANSITION_CATALOG);
  for (const [cohortId, recordDigest, eventDigest, version] of [
    ["docs-2026-09-10-stable18", "a156140015084e74459f1bc8dc6c61dfad9bf5d8f85cfbcba8cfdd7700f1867a",
      "5dfc82cfcb9f6be5484369ce4a39ff23dd6f4b74836f9fc5a164a4bf6dd56e18", "0.2.3"],
    ["docs-2026-09-10-stable19", "4dab45bfb69bc75ab63180f22e18ad036ed87107f11d2edd843c5f1f82b5f5bf",
      "30385945e581851788e955d406f4e7264c731f3a29a8b9cff4c3ecce1c3bd05a", "0.2.5"]
  ]) {
    const bundle = catalog.directTargetBundles.find(({ cohort }) => cohort.cohortId === cohortId);
    assert.ok(bundle, `Missing qualified upgrade origin ${cohortId}`);
    assert.equal(bundle.cohort.schemaVersion, 2);
    assert.equal(bundle.cohort.recordDigest, `sha256:${recordDigest}`);
    assert.equal(bundle.cohort.qualificationEventDigest, `sha256:${eventDigest}`);
    assert.equal(bundle.cohort.packages.docsProtocolAgentTeams.version, version);
    for (const [key, name] of [["skill", "skill.md"], ["callerWorkflow", "caller.yml"]]) {
      assert.equal(bundle[`${key}Path`],
        `assets/history/${bundle[`${key}Digest`].replace(":", "-")}/${name}`);
      assert.equal(digest(await readFile(join(import.meta.dirname, "..", bundle[`${key}Path`]))),
        bundle.cohort.assets[`${key}Digest`]);
    }
  }
  const legacy = await loadPackageConsumerAssetCatalog();
  assert.ok(legacy.directTargetBundles.every(({ cohort }) => cohort.schemaVersion === 1));
});

test("package loader rejects malformed or corrupted generation2 history before legacy filtering", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "docs-history-sandbox-"));
  const packageRoot = join(import.meta.dirname, "..");
  try {
    for (const path of ["dist", "assets", "package.json"]) {
      await cp(join(packageRoot, path), join(sandbox, path), { recursive: true });
    }
    await symlink(join(packageRoot, "node_modules"), join(sandbox, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    const load = () => execFileSync(process.execPath, ["--input-type=module", "--eval",
      "import { loadPackageConsumerAssetCatalog } from './dist/consumer-integration/adapters/package-consumer-asset-catalog.js'; await loadPackageConsumerAssetCatalog();"
    ], { cwd: sandbox, stdio: "pipe" });
    const original = JSON.parse(CANONICAL_TRANSITION_CATALOG);
    const catalogPath = join(sandbox, "assets/transition-catalog.json");
    for (const mutate of [
      (bundle) => { bundle.cohort.schemas.managedState = 1; },
      (bundle) => { delete bundle.cohort.packages.repositoryMutation; },
      (bundle) => { bundle.cohort.assets.skillDigest = `sha256:${"0".repeat(64)}`; },
      (bundle) => { bundle.agentsRouteDigest = "invalid"; }
    ]) {
      const catalog = structuredClone(original);
      mutate(catalog.directTargetBundles.at(-1));
      await writeFile(catalogPath, JSON.stringify(catalog));
      assert.throws(load, /TypeError/u);
    }
    await writeFile(catalogPath, CANONICAL_TRANSITION_CATALOG);
    await writeFile(join(sandbox, original.directTargetBundles.at(-1).skillPath), "tampered");
    assert.throws(load, /digest mismatch/u);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

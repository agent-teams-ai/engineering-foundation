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
const PRIOR_DIRECT_TARGET_BUNDLES_DIGEST =
  "sha256:0a4400a503795b3335ff55d0290aee0ff3364cb1b17244a8cac7e5d491b60c74";
const PUBLISHED_DIRECT_TARGET_BUNDLES_DIGEST =
  "sha256:d5de2d9cf1076230dc663f6f1d99b21d39a4d0540cfe235a1af46236de177111";

const STABLE23_COHORT = {
  schemaVersion: 2,
  cohortId: "docs-2026-09-15-stable23",
  channel: "stable",
  recordDigest: "sha256:287fca0b66c212e93d865b3a54fcb681eda12f4f8954c077a59148a348a361c9",
  qualificationEventDigest: "sha256:d65de3c1885c948dcdfa9b7fe79e9638ed74542ac32b85097ece90b5e02866d9",
  eligibleAfter: "2026-09-14T23:46:38Z",
  upgradeFrom: ["docs-2026-09-11-stable20"],
  rollbackTo: ["docs-2026-09-11-stable20"],
  packages: {
    repositoryMutation: {
      version: "0.2.0",
      integrity: "sha512-a02kzLlWtQjPAG2fFo/HyC+T6D+hW+FJ+aNCYoTLuTdKqeuL50hIvSnQLMUbGajWBb4nAvaINvW2jvmJ+Qku0g=="
    },
    documentAuthoring: {
      version: "0.3.0",
      integrity: "sha512-LdNT8VHPQxXvuyXsCblFSeCmbEEZcXwiCTY1E+c0ZEWWJG0V2qoi95F8fHAwI4ngZLDmLr/yzHGyDqwkd9GBrA=="
    },
    docsProtocol: {
      version: "0.6.0",
      integrity: "sha512-xSlc0DFTGh0jed9581LoToHAXwxxZMhzlItbPeoc67YNBSDxLCP8XNwK0LCMs4w8MLqY6silJDtpzsHFw2XSVg=="
    },
    docsProtocolAgentTeams: {
      version: "0.2.8",
      integrity: "sha512-C9AHrx68EqtdJ3kUAyLu6mCYnsVU63QSk4sQqWfoTijODqg9mMktaUGcjsc1G+BYqupJUI0QhgwCcPilg+aonA=="
    },
    engineeringFoundation: {
      version: "1.3.3",
      integrity: "sha512-WNHEi2A3Hx7KvHha3hJapTQn4u6m5DLk/VkBuLe4Y6EeosMsCJazBJ8gfOdcbupid9qjaEeT/0RNDhlIBs2eVw=="
    }
  },
  workflow: {
    repository: "agent-teams-ai/.github",
    path: ".github/workflows/docs-protocol-check.yml",
    revision: "757122cb08ed15aba6c9eef1b1f655b77d1ac54b",
    blobSha: "9bcbe54dfec6280045ac596e55c1f14ce5f176e1"
  },
  assets: {
    skillDigest: "sha256:a86d8c9b990124f11b50b1c6703e1aeb5e3b981d51f7e8f5c163c4f5b987d7c5",
    callerWorkflowDigest: "sha256:d8d3b1281990179ee25ded67ba160f0e7573d2f70707b8c5b312d70b68d85125",
    assetCatalogDigest: "sha256:3ec380a1a6dd8534824ba82ff23affba993e19e9cb6b3c5e424ea9973ad686da",
    transitionCatalogDigest: "sha256:ab84cf314a24f9f32a3baabce0c814699366af6c2a4aeb91e59327bb6783606f"
  },
  schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
  runtime: {
    node: ">=24.18.0 <25",
    pnpm: ">=11.17.0 <12",
    runtimeClosureDigest: "sha256:6e768aa2e3be45c358d27d6a8a234f10806ba9ac22f1a003b36396ecc41ae157"
  }
};

test("stable18 through stable26 history bind exact generation2 authority and immutable assets", async () => {
  const catalog = JSON.parse(CANONICAL_TRANSITION_CATALOG);
  assert.equal(
    digest(Buffer.from(JSON.stringify(catalog.directTargetBundles.slice(0, 17)))),
    PRIOR_DIRECT_TARGET_BUNDLES_DIGEST,
    "The 17 previously published direct-target bundles must remain byte-for-byte unchanged"
  );
  assert.equal(digest(Buffer.from(JSON.stringify(catalog.directTargetBundles.slice(0, -1)))),
    PUBLISHED_DIRECT_TARGET_BUNDLES_DIGEST,
    "All 18 published bundles, including stable26, must remain byte-for-byte unchanged");
  for (const [cohortId, recordDigest, eventDigest, version] of [
    ["docs-2026-09-10-stable18", "a156140015084e74459f1bc8dc6c61dfad9bf5d8f85cfbcba8cfdd7700f1867a",
      "5dfc82cfcb9f6be5484369ce4a39ff23dd6f4b74836f9fc5a164a4bf6dd56e18", "0.2.3"],
    ["docs-2026-09-10-stable19", "4dab45bfb69bc75ab63180f22e18ad036ed87107f11d2edd843c5f1f82b5f5bf",
      "30385945e581851788e955d406f4e7264c731f3a29a8b9cff4c3ecce1c3bd05a", "0.2.5"],
    ["docs-2026-09-11-stable20", "a2c8ac85c2f0afdaea498d5c994cb897ecabcbe6e97690dc3c5d416cd827b810",
      "94ef24e30cc5441fc99a7d8bbbd1952b07438a60642818d429062633a7277d95", "0.2.7"],
    ["docs-2026-09-12-stable21", "bf5220b191c7339533d21acd9b79594c274567ff0f515b72c4818863819ca92a",
      "4608734de08ad19ab6f787448d73bf92990115668c9d3d34cff5bba134efdc3b", "0.2.7"],
    ["docs-2026-09-15-stable23", "287fca0b66c212e93d865b3a54fcb681eda12f4f8954c077a59148a348a361c9",
      "d65de3c1885c948dcdfa9b7fe79e9638ed74542ac32b85097ece90b5e02866d9", "0.2.8"]
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
  const stable21 = catalog.directTargetBundles.find(
    ({ cohort }) => cohort.cohortId === "docs-2026-09-12-stable21"
  );
  assert.ok(stable21);
  assert.deepEqual(stable21.cohort.upgradeFrom,
    ["docs-2026-09-10-stable18", "docs-2026-09-10-stable19"]);
  assert.deepEqual(stable21.cohort.rollbackTo,
    ["docs-2026-09-10-stable18", "docs-2026-09-10-stable19"]);
  assert.equal(stable21.cohort.runtime.runtimeClosureDigest,
    "sha256:ac3ca2c5d7aaed71fa64b0ee3c101b48056c24935bada544529403cef608d711");
  assert.equal(stable21.cohort.assets.transitionCatalogDigest,
    "sha256:77ab3d28d39c6959ae3e5be2e9202b704dd9f57bbc9aed6824de81458c773de9");
  const stable23 = catalog.directTargetBundles.find(
    ({ cohort }) => cohort.cohortId === STABLE23_COHORT.cohortId
  );
  assert.ok(stable23);
  assert.deepEqual(stable23, {
    agentsRouteDigest: "sha256:08ca6c0782dbc36ace6359c8fe36807810f9668d999c7d9e8ead6bf281d9bf30",
    callerWorkflowDigest: STABLE23_COHORT.assets.callerWorkflowDigest,
    callerWorkflowPath: "assets/history/sha256-d8d3b1281990179ee25ded67ba160f0e7573d2f70707b8c5b312d70b68d85125/caller.yml",
    cohort: STABLE23_COHORT,
    docsScriptsDigest: "sha256:7a502ddeda5e3d0296b712b5c07e0905a9b7a8fcd374d37db8a02cb026a37881",
    skillDigest: STABLE23_COHORT.assets.skillDigest,
    skillPath: "assets/history/sha256-a86d8c9b990124f11b50b1c6703e1aeb5e3b981d51f7e8f5c163c4f5b987d7c5/skill.md"
  });
  const stable26 = catalog.directTargetBundles.find(
    ({ cohort }) => cohort.cohortId === "docs-2026-09-21-stable26"
  );
  assert.ok(stable26);
  assert.equal(stable26.cohort.schemaVersion, 2);
  assert.equal(stable26.cohort.recordDigest,
    "sha256:c96167d5b3fa35b9f331c528e0b3055643e5ba702eb08d1eee1c412e78889c30");
  assert.equal(stable26.cohort.qualificationEventDigest,
    "sha256:2b4b2b27583a6f2fd188f47ac8ec29e52db8224fcc66ab0ba1a364ba27312589");
  assert.equal(stable26.cohort.packages.docsProtocolAgentTeams.version, "0.2.9");
  assert.equal(stable26.skillPath, stable23.skillPath);
  assert.equal(stable26.callerWorkflowPath, stable23.callerWorkflowPath);
  const stable25 = catalog.directTargetBundles.find(
    ({ cohort }) => cohort.cohortId === "docs-2026-09-16-stable25"
  );
  assert.ok(stable25);
  assert.equal(stable25.cohort.recordDigest,
    "sha256:105c34ecc7fc422939b43daaca513f9ce630ce69d4a2820d39423fcdc13dcc61");
  assert.equal(stable25.cohort.qualificationEventDigest,
    "sha256:090325fe7992c7ca15e03a5375188d006d8c410f7a895a219fafb4e735f5d28b");
  assert.deepEqual(stable25.cohort.upgradeFrom, ["docs-2026-09-12-stable21"]);
  assert.deepEqual(stable25.cohort.rollbackTo, ["docs-2026-09-12-stable21"]);
  assert.deepEqual(stable25.cohort.assets, stable26.cohort.assets);
  assert.deepEqual(stable25.cohort.workflow, stable26.cohort.workflow);
  assert.deepEqual(stable25.cohort.schemas,
    { consumerIntegration: 3, managedState: 2, docsProtocol: 1 });
  assert.equal(stable25.cohort.runtime.runtimeClosureDigest,
    "sha256:87cb5e3495848f453c1ac0e4dc8caa7d66828f0cab270cefd46d73dee2ea341a");
  assert.deepEqual(Object.fromEntries(Object.entries(stable25.cohort.packages).map(
    ([name, { version }]) => [name, version]
  )), {
    repositoryMutation: "0.2.0", documentAuthoring: "0.3.0", docsProtocol: "0.6.0",
    docsProtocolAgentTeams: "0.2.9", engineeringFoundation: "1.4.0"
  });
  assert.deepEqual(stable25.cohort.packages.repositoryMutation, stable26.cohort.packages.repositoryMutation);
  assert.deepEqual(stable25.cohort.packages.documentAuthoring, stable26.cohort.packages.documentAuthoring);
  assert.deepEqual(stable25.cohort.packages.docsProtocol, stable26.cohort.packages.docsProtocol);
  assert.deepEqual(stable25.cohort.packages.docsProtocolAgentTeams, stable26.cohort.packages.docsProtocolAgentTeams);
  assert.equal(stable25.cohort.packages.engineeringFoundation.integrity,
    "sha512-m8rLOvctyXu+kqN4LyCW4LIz303a7p+ZIvx+oieYIwst6DNBpsWUu/Ux7UZM3fZH5JTYhB4eSEBEfi5lUTt4vQ==");
  for (const [path, expected] of [[stable25.skillPath, stable25.skillDigest],
    [stable25.callerWorkflowPath, stable25.callerWorkflowDigest]]) {
    assert.equal(digest(await readFile(join(import.meta.dirname, "..", path))), expected);
  }
  const legacy = await loadPackageConsumerAssetCatalog();
  assert.ok(legacy.directTargetBundles.every(({ cohort }) => cohort.schemaVersion === 1));
  assert.deepEqual(legacy.historicalV2Bundles.map(({ cohort }) => cohort.cohortId), [
    "docs-2026-09-10-stable18", "docs-2026-09-10-stable19", "docs-2026-09-11-stable20",
    "docs-2026-09-12-stable21", "docs-2026-09-15-stable23", "docs-2026-09-21-stable26",
    "docs-2026-09-16-stable25"
  ]);
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
    const stable23 = original.directTargetBundles.find(
      ({ cohort }) => cohort.cohortId === STABLE23_COHORT.cohortId
    );
    assert.ok(stable23);
    const catalogPath = join(sandbox, "assets/transition-catalog.json");
    for (const mutate of [
      (bundle) => { bundle.cohort.recordDigest = "invalid"; },
      (bundle) => { bundle.cohort.qualificationEventDigest = "invalid"; },
      (bundle) => { bundle.cohort.schemas.managedState = 1; },
      (bundle) => { delete bundle.cohort.packages.repositoryMutation; },
      (bundle) => { bundle.cohort.assets.skillDigest = `sha256:${"0".repeat(64)}`; },
      (bundle) => { bundle.skillPath = bundle.callerWorkflowPath; },
      (bundle) => { bundle.agentsRouteDigest = "invalid"; }
    ]) {
      const catalog = structuredClone(original);
      mutate(catalog.directTargetBundles.find(
        ({ cohort }) => cohort.cohortId === STABLE23_COHORT.cohortId
      ));
      await writeFile(catalogPath, JSON.stringify(catalog));
      assert.throws(load, /TypeError/u);
    }
    const stable25Id = "docs-2026-09-16-stable25";
    const wrongIntegrity = structuredClone(original);
    wrongIntegrity.directTargetBundles.find(
      ({ cohort }) => cohort.cohortId === stable25Id
    ).cohort.packages.engineeringFoundation.integrity = "sha512-invalid";
    await writeFile(catalogPath, JSON.stringify(wrongIntegrity));
    assert.throws(load, /TypeError/u);
    const missingAsset = structuredClone(original);
    missingAsset.directTargetBundles.find(
      ({ cohort }) => cohort.cohortId === stable25Id
    ).skillPath = "assets/history/sha256-" + "0".repeat(64) + "/skill.md";
    await writeFile(catalogPath, JSON.stringify(missingAsset));
    assert.throws(load);
    const duplicate = structuredClone(original);
    duplicate.directTargetBundles.push(structuredClone(stable23));
    await writeFile(catalogPath, JSON.stringify(duplicate));
    assert.throws(load, /identities must be unique/u);

    await writeFile(catalogPath, CANONICAL_TRANSITION_CATALOG);
    await rm(join(sandbox, stable23.callerWorkflowPath));
    assert.throws(load, /ENOENT/u);
    await cp(
      join(packageRoot, stable23.callerWorkflowPath),
      join(sandbox, stable23.callerWorkflowPath)
    );
    await writeFile(join(sandbox, stable23.skillPath), "tampered");
    assert.throws(load, /digest mismatch/u);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

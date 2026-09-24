import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertPackedDocsAdapterHistory } from "../scripts/pack-docs-adapter-history.mjs";

const catalog = JSON.parse(await readFile(new URL(
  "../packages/docs-protocol-agent-teams/assets/transition-catalog.json",
  import.meta.url
), "utf8"));

function changedCatalog(change) {
  const copy = structuredClone(catalog);
  change(copy.directTargetBundles);
  return copy;
}

export function registerPackedDocsAdapterHistoryTests() {
  test("packed adapter history accepts stable21 and stable25 after stable26", () => {
    const stable23 = assertPackedDocsAdapterHistory(catalog);
    assert.equal(stable23.cohort.cohortId, "docs-2026-09-15-stable23");
    const cohortIds = catalog.directTargetBundles.map(({ cohort }) => cohort.cohortId);
    assert(cohortIds.includes("docs-2026-09-12-stable21"));
    assert(cohortIds.includes("docs-2026-09-16-stable25"));
  });

  test("packed adapter history rejects missing, reordered, and duplicate cohorts", () => {
    for (const change of [
      (bundles) => bundles.pop(),
      (bundles) => bundles.splice(0, bundles.length, ...bundles.toReversed()),
      (bundles) => bundles.push(structuredClone(bundles.at(-1)))
    ]) {
      assert.throws(() => assertPackedDocsAdapterHistory(changedCatalog(change)),
        /incomplete, reordered, or duplicated/);
    }
  });

  test("packed adapter history rejects changed stable25 authority and integrity", () => {
    for (const change of [
      (bundle) => { bundle.cohort.recordDigest = "sha256:changed"; },
      (bundle) => { bundle.cohort.qualificationEventDigest = "sha256:changed"; },
      (bundle) => { bundle.cohort.assets.transitionCatalogDigest = "sha256:changed"; },
      (bundle) => { bundle.cohort.packages.engineeringFoundation.integrity = "sha512-changed"; },
      (bundle) => { delete bundle.cohort.packages; },
      (bundle) => { delete bundle.cohort.packages.engineeringFoundation; },
      (bundle) => { bundle.skillPath = "assets/changed-skill.md"; }
    ]) {
      assert.throws(() => assertPackedDocsAdapterHistory(changedCatalog(
        (bundles) => change(bundles.at(-1))
      )), /stable25 projection differs/);
    }
  });

  test("packed adapter history rejects missing route and script digests in both cohorts", () => {
    for (const field of ["agentsRouteDigest", "docsScriptsDigest"]) {
      const changed = changedCatalog((bundles) => {
        for (const bundle of bundles.filter(({ cohort }) =>
          ["docs-2026-09-16-stable25", "docs-2026-09-21-stable26"].includes(cohort.cohortId))) {
          delete bundle[field];
        }
      });
      assert.throws(() => assertPackedDocsAdapterHistory(changed),
        /stable25 projection differs/);
    }
  });

  test("packed adapter history still qualifies stable26 by cohort ID", () => {
    const changed = changedCatalog((bundles) => {
      const stable26 = bundles.find(({ cohort }) => cohort.cohortId === "docs-2026-09-21-stable26");
      stable26.cohort.recordDigest = "sha256:changed";
    });
    assert.throws(() => assertPackedDocsAdapterHistory(changed), /stable26 projection differs/);
  });
}

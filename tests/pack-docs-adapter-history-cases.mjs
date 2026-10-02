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

function* fieldPaths(value, prefix = []) {
  for (const [key, field] of Object.entries(value)) {
    const path = [...prefix, key];
    yield path;
    if (field !== null && typeof field === "object") {
      yield* fieldPaths(field, path);
    }
  }
}

function changedValue(value) {
  if (typeof value === "number") { return value + 1; }
  if (typeof value === "string" && value.startsWith("sha256:")) {
    return `sha256:${"0".repeat(64)}`;
  }
  if (typeof value === "string" && value.startsWith("sha512-")) {
    return `sha512-${"A".repeat(86)}==`;
  }
  if (typeof value === "string" && /^\d+\.\d+\.\d+$/u.test(value)) { return "99.0.0"; }
  if (Array.isArray(value)) { return [...value, "docs-2026-09-12-stable21"]; }
  if (value !== null && typeof value === "object") { return { ...value, unexpected: true }; }
  return `${value}-changed`;
}

export function registerPackedDocsAdapterHistoryTests() {
  test("packed adapter history accepts stable24 and stable28 appended after stable25", () => {
    const stable23 = assertPackedDocsAdapterHistory(catalog);
    assert.equal(stable23.cohort.cohortId, "docs-2026-09-15-stable23");
    const cohortIds = catalog.directTargetBundles.map(({ cohort }) => cohort.cohortId);
    assert(cohortIds.includes("docs-2026-09-12-stable21"));
    assert(cohortIds.includes("docs-2026-09-16-stable25"));
    assert.equal(cohortIds.length, 21);
    assert.deepEqual(cohortIds.slice(-2), [
      "docs-2026-09-15-stable24", "docs-2026-09-24-stable28"
    ]);
  });

  test("packed adapter history rejects missing, reordered, duplicate, and unknown cohorts", () => {
    assertPackedDocsAdapterHistory(catalog);
    for (const change of [
      (bundles) => bundles.pop(),
      (bundles) => bundles.splice(0, bundles.length, ...bundles.toReversed()),
      (bundles) => bundles.push(structuredClone(bundles.at(-1))),
      (bundles) => { bundles.at(-1).cohort.cohortId = "docs-unknown"; }
    ]) {
      assert.throws(() => assertPackedDocsAdapterHistory(changedCatalog(change)),
        /incomplete, reordered, or duplicated/);
    }
  });

  test("packed adapter history rejects changed stable25 authority and integrity", () => {
    assertPackedDocsAdapterHistory(catalog);
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
        (bundles) => change(bundles.find(({ cohort }) =>
          cohort.cohortId === "docs-2026-09-16-stable25"))
      )), /stable25 projection differs/);
    }
  });

  test("packed adapter history rejects missing route and script digests in both cohorts", () => {
    assertPackedDocsAdapterHistory(catalog);
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
    assertPackedDocsAdapterHistory(catalog);
    const changed = changedCatalog((bundles) => {
      const stable26 = bundles.find(({ cohort }) => cohort.cohortId === "docs-2026-09-21-stable26");
      stable26.cohort.recordDigest = "sha256:changed";
    });
    assert.throws(() => assertPackedDocsAdapterHistory(changed), /stable26 projection differs/);
  });

  for (const cohortId of ["docs-2026-09-15-stable24", "docs-2026-09-24-stable28"]) {
    test(`packed adapter history rejects every changed or missing ${cohortId} projection field`, () => {
      assertPackedDocsAdapterHistory(catalog);
      const original = catalog.directTargetBundles.find(({ cohort }) => cohort.cohortId === cohortId);
      assert.ok(original);
      for (const path of fieldPaths(original)) {
        for (const remove of [false, true]) {
          const changed = changedCatalog((bundles) => {
            const bundle = bundles.find(({ cohort }) => cohort.cohortId === cohortId);
            const parent = path.slice(0, -1).reduce((value, key) => value[key], bundle);
            const key = path.at(-1);
            if (remove) { delete parent[key]; }
            else { parent[key] = changedValue(parent[key]); }
          });
          assert.throws(() => assertPackedDocsAdapterHistory(changed),
            `${cohortId}: ${remove ? "missing" : "changed"} ${path.join(".")}`);
        }
      }
    });
  }
}

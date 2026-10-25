import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { QualifiedDocsCohortBindingV1 } from "../dist/consumer-integration/index.js";
import { CANONICAL_DOCS_SKILL, canonicalManagedRoute } from "../dist/consumer-integration/index.js";
import { loadPackageConsumerAssetCatalog } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import {
  CANONICAL_DOCS_SKILL_V2,
  CANONICAL_CALLER_WORKFLOW_TEMPLATE,
  CANONICAL_ASSET_CATALOG,
  CANONICAL_TRANSITION_CATALOG,
  describeCanonicalConsumerAssets,
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export async function assertCanonicalPackageAssets(
  targetCohort: QualifiedDocsCohortBindingV1,
): Promise<void> {
  const packageRoot = join(import.meta.dirname, "..");
  const [skill, workflow, catalogSource, transitionCatalogSource] = await Promise.all([
    readFile(join(packageRoot, "skills", "docs", "SKILL.md"), "utf8"),
    readFile(join(packageRoot, "assets", "docs-protocol.yml"), "utf8"),
    readFile(join(packageRoot, "assets", "catalog.json"), "utf8"),
    readFile(join(packageRoot, "assets", "transition-catalog.json"), "utf8"),
  ]);
  assert.equal(skill, CANONICAL_DOCS_SKILL_V2);
  assert.equal(
    digest(Buffer.from(CANONICAL_DOCS_SKILL, "utf8")),
    "sha256:7b31cd257532247f64c55a014dc926c601e4d742176cfb8513b6b0d8ab48213e",
  );
  assert.equal(workflow, CANONICAL_CALLER_WORKFLOW_TEMPLATE);
  assert.equal(catalogSource, CANONICAL_ASSET_CATALOG);
  assert.equal(transitionCatalogSource, CANONICAL_TRANSITION_CATALOG);
  const transitionCatalog = JSON.parse(transitionCatalogSource) as {
    currentSourceExecutors: unknown[];
    directTargetBundles: { cohort: { cohortId: string } }[];
  };
  assert.deepEqual(transitionCatalog.currentSourceExecutors, []);
  assert.deepEqual(
    transitionCatalog.directTargetBundles.map(({ cohort: { cohortId } }) => cohortId),
    [
      "docs-2026-08-17-rc1",
      "docs-2026-08-17-rc7",
      "docs-2026-08-17-rc9",
      "docs-2026-08-18-rc1",
      "docs-2026-08-18-rc2",
      "docs-2026-08-18-rc3",
      "docs-2026-08-23-stable1",
      "docs-2026-08-24-stable2",
      "docs-2026-08-25-stable3",
      "docs-2026-08-28-stable8",
      "docs-2026-08-28-stable9.1",
      "docs-2026-08-31-stable10",
      "docs-2026-09-10-stable18",
      "docs-2026-09-10-stable19",
      "docs-2026-09-11-stable20",
      "docs-2026-09-12-stable21",
      "docs-2026-09-15-stable23",
      "docs-2026-09-21-stable26",
      "docs-2026-09-16-stable25",
      "docs-2026-09-15-stable24",
      "docs-2026-09-24-stable28",
      "docs-2026-10-03-stable31",
    ],
  );
  const loadedTransitions = await loadPackageConsumerAssetCatalog();
  assert.deepEqual(
    loadedTransitions.directTargetBundles.map(({ cohort: { cohortId } }) => cohortId),
    [
      "docs-2026-08-17-rc1",
      "docs-2026-08-17-rc7",
      "docs-2026-08-17-rc9",
      "docs-2026-08-18-rc1",
      "docs-2026-08-18-rc2",
      "docs-2026-08-18-rc3",
      "docs-2026-08-23-stable1",
      "docs-2026-08-24-stable2",
      "docs-2026-08-25-stable3",
      "docs-2026-08-28-stable8",
      "docs-2026-08-28-stable9.1",
      "docs-2026-08-31-stable10",
    ],
  );
  const catalog = JSON.parse(catalogSource) as {
    skillDigest: string;
    callerWorkflowTemplateDigest: string;
    routeTemplate: string;
    scriptsTemplate: Record<string, string>;
  };
  assert.equal(catalog.skillDigest, digest(Buffer.from(skill)));
  assert.equal(catalog.callerWorkflowTemplateDigest, digest(Buffer.from(workflow)));
  assert.equal(catalog.routeTemplate, canonicalManagedRoute("{skillPath}"));
  assert.deepEqual(
    catalog.scriptsTemplate,
    Object.fromEntries(
      ["check", "doctor", "find", "info", "new", "recover"].map((command) => [
        `docs:${command}`,
        `agent-teams-docs ${command} --consumer . --profile {profilePath}`,
      ]),
    ),
  );
  assert.equal(
    describeCanonicalConsumerAssets(targetCohort).skillDigest,
    digest(Buffer.from(skill)),
  );
  assert.equal(
    describeCanonicalConsumerAssets(targetCohort).assetCatalogDigest,
    digest(Buffer.from(catalogSource)),
  );
  assert.equal(
    describeCanonicalConsumerAssets(targetCohort).transitionCatalogDigest,
    digest(Buffer.from(transitionCatalogSource)),
  );
  assert.match(
    workflow,
    /^name: Documentation Protocol\n\non:\n  pull_request:\n  merge_group:\n  push:\n/u,
  );
  assert.match(workflow, /\npermissions:\n  contents: read\n  id-token: write\n\njobs:\n/u);
  assert.equal(workflow.match(/^permissions:/gmu)?.length, 1);
  assert.doesNotMatch(workflow, /\bwith:/u);
}

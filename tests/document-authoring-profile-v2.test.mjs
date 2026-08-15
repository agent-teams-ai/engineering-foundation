import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadValidatedDocumentAuthoringProfileV2 } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/load-validated-document-authoring-profile-v2.js";
import { NodeDocumentPlanningProfileReader } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-planning-profile-reader.js";
import { PlanDocumentationDocument } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/plan-documentation-document.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const v2FixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-profile-v2.json", import.meta.url),
);
const v2Fixture = JSON.parse(await readFile(v2FixturePath, "utf8"));

function profileV2() {
  return structuredClone(v2Fixture);
}

async function rejectsV2(value) {
  await assert.rejects(
    assertSchema("document-authoring-profile/v2", value, "profile-v2-test"),
    (error) => error?.problem?.code === "SCHEMA_INVALID",
  );
}

test("closed v2 schema validates the complete profile directly", async () => {
  const valid = profileV2();
  await assertSchema("document-authoring-profile/v2", valid, "profile-v2-test");

  for (const mutate of [
    (value) => { value.unknown = true; },
    (value) => { value.catalog.metadataSidecar.unknown = true; },
    (value) => { value.authoring.artifactTypes[0].unknown = true; },
    (value) => { delete value.authoring.artifactTypes[0].allowedOwnerIds; },
    (value) => { value.authoring.artifactTypes[0].allowedOwnerIds = []; },
    (value) => { value.authoring.artifactTypes[0].allowedOwnerIds = ["architecture", "architecture"]; },
    (value) => { value.authoring.artifactTypes[0].allowedOwnerIds = ["bad owner"]; },
  ]) {
    const invalid = profileV2();
    mutate(invalid);
    await rejectsV2(invalid);
  }
});

test("v2 not-required reachability is closed and requires a bounded reason", async () => {
  const valid = profileV2();
  valid.authoring.artifactTypes[0].reachability = {
    kind: "not-required",
    reason: "This artifact is intentionally terminal.",
  };
  await assertSchema("document-authoring-profile/v2", valid, "profile-v2-test");

  for (const reachability of [
    { kind: "not-required" },
    { kind: "not-required", reason: "" },
    { kind: "not-required", reason: "invalid\u0000reason" },
    { kind: "not-required", reason: "valid", unknown: true },
  ]) {
    const invalid = profileV2();
    invalid.authoring.artifactTypes[0].reachability = reachability;
    await rejectsV2(invalid);
  }
});

test("v2 loader uses direct schema validation and preserves v1 compatibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-profile-v2-"));
  try {
    await writeFile(join(root, "profile.json"), `${JSON.stringify(profileV2())}\n`);
    const loaded = await loadValidatedDocumentAuthoringProfileV2({
      consumerRoot: root,
      path: "profile.json",
    });
    assert.equal(loaded.profile.schemaVersion, 2);
    assert.deepEqual(
      loaded.profile.authoring.artifactTypes[0].allowedOwnerIds,
      ["architecture", "platform/runtime"],
    );
    const planning = await new NodeDocumentPlanningProfileReader().read({
      consumerRoot: root,
      path: "profile.json",
    });
    assert.equal(planning.schemaVersion, 2);
    assert.deepEqual(planning.artifactTypes[0].allowedOwnerIds, [
      "architecture",
      "platform/runtime",
    ]);
    assert.equal(Object.isFrozen(planning.artifactTypes[0].allowedOwnerIds), true);

    const invalid = profileV2();
    invalid.catalog.metadataSidecar.extra = "projection-used-to-hide-this";
    await writeFile(join(root, "profile.json"), `${JSON.stringify(invalid)}\n`);
    await assert.rejects(
      loadValidatedDocumentAuthoringProfileV2({
        consumerRoot: root,
        path: "profile.json",
      }),
      (error) => error?.name === "InvalidDocumentAuthoringProfileError",
    );

    await writeFile(join(root, "profile.json"), `${JSON.stringify(fixture.profile)}\n`);
    assert.equal(
      (await loadValidatedDocumentAuthoringProfileV2({
        consumerRoot: root,
        path: "profile.json",
      })).profile.schemaVersion,
      1,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("planning rejects an owner outside the selected v2 artifact allowlist", async () => {
  let resolved = false;
  const intent = {
    schemaVersion: 1,
    type: "adr",
    id: "ADR-0001",
    title: "Bound owners",
    owner: "security",
    summary: "Owner policy is enforced before authority loading.",
  };
  const artifact = {
    ...profileV2().authoring.artifactTypes[0],
    allowedOwnerIds: ["architecture"],
  };
  const planner = new PlanDocumentationDocument({
    catalog: {},
    compiler: {},
    contracts: { async validateIntent() { return intent; } },
    metadata: {},
    owners: {},
    policies: {
      normalizeDocumentIntent(value) { return value; },
      selectDocumentArtifact() { return artifact; },
      resolveDocumentAuthoring() { resolved = true; throw new Error("unexpected"); },
    },
    profile: {
      async read() {
        return {
          artifactTypes: [artifact],
          collections: [],
          evidence: {},
          excludedPrefixes: [],
          metadataSchemaPath: "docs/metadata.schema.json",
          ownerCatalog: { contract: "foundation.owner-map/v1", path: "docs/owners.yaml" },
          projectId: "fixture",
          schemaVersion: 2,
        };
      },
    },
    renderer: {},
    state: {},
    templates: {},
  });
  await assert.rejects(
    planner.execute({
      consumerRoot: "/unused",
      profilePath: "profile.json",
      intent,
      parentPolicy: "create-missing-real-directories",
    }),
    (error) =>
      error?.code === "DOCUMENT_PLANNING_INPUT_INVALID" &&
      /not allowed for artifact type adr/u.test(error.message),
  );
  assert.equal(resolved, false);
});

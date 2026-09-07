import { readContainedRegularFile } from "../packages/document-authoring/dist/documentation-observation/module.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadValidatedDocumentAuthoringProfileV2 } from "../packages/document-authoring/dist/document-authoring/adapters/node/load-validated-document-authoring-profile-v2.js";
import { NodeDocumentPlanningProfileReader } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-planning-profile-reader.js";
import { PlanDocumentationDocument } from "../packages/document-authoring/dist/document-authoring/application/use-cases/plan-documentation-document.js";
import { assertSchema } from "../packages/document-authoring/dist/document-authoring/adapters/node/schema-catalog.js";

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
    const loaded = await loadValidatedDocumentAuthoringProfileV2(readContainedRegularFile, {
      consumerRoot: root,
      path: "profile.json",
    });
    assert.equal(loaded.profile.schemaVersion, 2);
    assert.deepEqual(
      loaded.profile.authoring.artifactTypes[0].allowedOwnerIds,
      ["architecture", "platform/runtime"],
    );
    const planning = await new NodeDocumentPlanningProfileReader(readContainedRegularFile).read({
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
      loadValidatedDocumentAuthoringProfileV2(readContainedRegularFile, {
        consumerRoot: root,
        path: "profile.json",
      }),
      (error) => error?.name === "InvalidDocumentAuthoringProfileError",
    );

    await writeFile(join(root, "profile.json"), `${JSON.stringify(fixture.profile)}\n`);
    assert.equal(
      (await loadValidatedDocumentAuthoringProfileV2(readContainedRegularFile, {
        consumerRoot: root,
        path: "profile.json",
      })).profile.schemaVersion,
      1,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("v3 resolves one versioned local owner set without changing v2 authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-profile-v3-owner-sets-"));
  try {
    const profile = profileV2();
    profile.schemaVersion = 3;
    profile.authoring.ownerSets = {
      schemaVersion: 1,
      sets: { "architecture-docs": ["architecture", "platform/runtime"] },
    };
    delete profile.authoring.artifactTypes[0].allowedOwnerIds;
    profile.authoring.artifactTypes[0].ownerSetId = "architecture-docs";
    await assertSchema("document-authoring-profile/v3", profile, "profile-v3-test");
    await writeFile(join(root, "profile.json"), `${JSON.stringify(profile)}\n`);
    const planning = await new NodeDocumentPlanningProfileReader(readContainedRegularFile).read({
      consumerRoot: root,
      path: "profile.json",
    });
    assert.equal(planning.schemaVersion, 3);
    assert.deepEqual(planning.artifactTypes[0].allowedOwnerIds, [
      "architecture",
      "platform/runtime",
    ]);

    profile.authoring.artifactTypes[0].ownerSetId = "missing";
    await writeFile(join(root, "profile.json"), `${JSON.stringify(profile)}\n`);
    await assert.rejects(
      new NodeDocumentPlanningProfileReader(readContainedRegularFile).read({ consumerRoot: root, path: "profile.json" }),
      /unknown ownerSetId/u,
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

function descriptionEvidence(path) {
  return { path, digest: `sha256:${"a".repeat(64)}`, size: 1 };
}

test("description projects independent authority observations and preserves reader failures", async () => {
  const { projectDescription } = await import("../packages/document-authoring/dist/document-authoring/application/policies/project-document-authoring-description.js");
  const { describeDocumentAuthoringProfile } = await import("../packages/document-authoring/dist/document-authoring/application/use-cases/describe-document-authoring-profile.js");
  const profile = profileV2();
  const ownerIds = [...new Set(profile.authoring.artifactTypes.flatMap(type => type.allowedOwnerIds))];
  const authority = {
    profile,
    profileEvidence: descriptionEvidence("profile.json"),
    metadata: { evidence: descriptionEvidence("metadata.json"), requiredProperties: ["zeta", "id", "alpha"] },
    ownerCatalog: { evidence: descriptionEvidence("owners.json"), ids: ownerIds.toReversed() },
    templateEvidenceByPath: new Map(profile.authoring.artifactTypes.map(type => [type.template.path, descriptionEvidence(type.template.path)]))
  };
  const first = projectDescription(authority);
  assert.deepEqual(first.ownerIds, ownerIds.toSorted());
  assert.deepEqual(first.types[0].requiredMetadata, ["alpha", "id", "owner", "status", "summary", "type", "zeta"]);
  assert.ok(Object.isFrozen(first.types[0].requiredMetadata));
  const permutation = structuredClone(authority);
  permutation.profile.authoring.artifactTypes.reverse();
  permutation.metadata.requiredProperties.reverse();
  permutation.ownerCatalog.ids.reverse();
  assert.deepEqual(projectDescription(permutation), first);
  const calls = [];
  const request = { consumerRoot: "/unmounted-fake", profilePath: "profile.json" };
  assert.deepEqual(await describeDocumentAuthoringProfile(request, 2, async (input, version) => {
    calls.push([input, version]); return authority;
  }), first);
  assert.deepEqual(calls, [[request, 2], [request, 2]]);
  const ioFailure = new Error("Fake authority read failed");
  await assert.rejects(describeDocumentAuthoringProfile(request, 2, async () => { throw ioFailure; }), error => error === ioFailure);
  let read = 0;
  await assert.rejects(describeDocumentAuthoringProfile(request, 2, async () => {
    read += 1;
    return read === 1 ? authority : { ...authority, profileEvidence: { ...authority.profileEvidence, digest: `sha256:${"b".repeat(64)}` } };
  }), error => error.code === "DOCUMENT_CATALOG_AUTHORITY_CHANGED");
});

test("profile readers consume independent bounded-file observations and retain IO diagnostics", async () => {
  const { ContainedFileReadError } = await import("../packages/document-authoring/dist/documentation-observation/api.js");
  const requests = [];
  const bytes = new TextEncoder().encode(JSON.stringify(profileV2()));
  const loaded = await new NodeDocumentPlanningProfileReader(async request => {
    requests.push(request);
    return bytes;
  }).read({ consumerRoot: "/unmounted-fake", path: "profile.json" });
  assert.equal(loaded.schemaVersion, 2);
  assert.deepEqual(requests, [{ root: "/unmounted-fake", candidate: resolve("/unmounted-fake", "profile.json"), maxBytes: 1024 * 1024 }]);
  for (const kind of ["missing", "changed", "symlink", "escape", "invalid", "unavailable"]) {
    const failure = new ContainedFileReadError(kind);
    await assert.rejects(new NodeDocumentPlanningProfileReader(async () => { throw failure; })
      .read({ consumerRoot: "/unmounted-fake", path: "profile.json" }), error => {
        assert.equal(error.code, "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE");
        assert.equal(error.cause.code, "DOCUMENT_CATALOG_AUTHORITY_UNAVAILABLE");
        assert.equal(error.cause.cause, failure);
        assert.ok(error.message.endsWith(": profile.json."));
        return true;
      });
  }
});

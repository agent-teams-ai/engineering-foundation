import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";

import {
  projectConsumerIntegrationProfileV3,
  projectConsumerUpgradeFiles,
  projectPnpmWorkspaceCohortExclusionsV2,
  projectPnpmWorkspaceMigrationExclusionsV2
} from "../dist/consumer-integration/adapters/consumer-upgrade-file-projectors.js";
import {
  projectCohortV3AuthorityBinding
} from "../dist/consumer-integration/adapters/cohort-v3-authority-projector.js";
import {
  selectManagedSuccessorProfileV3
} from "../dist/consumer-integration/application/policies/managed-successor-state.js";
import {
  projectPnpmManifestCohortPinsV2
} from "../dist/consumer-integration/adapters/pnpm-manifest-adapter-v2.js";
import { assertConsumerIntegrationProfileSchema } from "../dist/consumer-integration/adapters/consumer-integration-schema-validator.js";
import {
  cohortV3Registry, rebindCohortV3Registry, sourceManifestV2
} from "./consumer-upgrade-e2e-fixtures.mjs";

const integrity = `sha512-${"A".repeat(86)}==`;
const coordinate = (version) => ({ version, integrity });

function cohort(suffix, version) {
  return {
    schemaVersion: 2,
    cohortId: `docs-v2-${suffix}`,
    channel: "stable",
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    eligibleAfter: "2026-09-04T00:00:00Z",
    upgradeFrom: suffix === "target" ? ["docs-v2-source"] : [],
    rollbackTo: suffix === "target" ? ["docs-v2-source"] : [],
    packages: {
      repositoryMutation: coordinate(version),
      documentAuthoring: coordinate(version),
      docsProtocol: coordinate(version),
      docsProtocolAgentTeams: coordinate(version),
      engineeringFoundation: coordinate(version)
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "3".repeat(40),
      blobSha: "4".repeat(40)
    },
    assets: {
      skillDigest: `sha256:${"5".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"6".repeat(64)}`,
      assetCatalogDigest: `sha256:${"7".repeat(64)}`,
      transitionCatalogDigest: `sha256:${"8".repeat(64)}`
    },
    schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: `sha256:${"9".repeat(64)}`
    }
  };
}

function profile(binding) {
  return {
    schemaVersion: 3,
    repository: {
      provider: "github",
      id: "999999999",
      nameWithOwner: "agent-teams-ai/docs-v3-sandbox"
    },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    governedDocsRoots: ["docs"],
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check"
    },
    cohort: binding
  };
}

function cohort3(suffix, options = {}) {
  return {
    ...cohort(suffix, options.version ?? "2.0.0"),
    schemaVersion: 3,
    candidateDigest: `sha256:${"a".repeat(64)}`,
    schemas: {
      consumerIntegration: 4,
      managedState: 3,
      qualificationReceipt: 1,
      docsProtocol: 1
    },
    runtime: {
      policy: {
        id: "agent-teams.docs-protocol-current-policy",
        version: "3.0.0",
        digest: "sha256:7af41f44a6e522b8919ace5f85499747215ddd1955199584c34046ec95c4b141"
      },
      selectedLane: "node-26-managed-qualified",
      node: ">=26.0.0 <27",
      pnpm: ">=11.17.0 <12",
      qualificationRuntime: {
        nodeVersion: "26.11.1",
        pnpmVersion: "11.20.0",
        platform: "linux",
        architecture: "x64"
      },
      runtimeClosure: {
        domain: "agent-teams.docs-runtime-closure/v2",
        digest: `sha256:${"9".repeat(64)}`
      }
    },
    upgradeFrom: [`${options.sourceCohortId ?? "docs-v2-source"}`],
    rollbackTo: [`${options.sourceCohortId ?? "docs-v2-source"}`]
  };
}

function authority3(cohortBinding, options = {}) {
  return {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision: "8".repeat(40),
    cohort: {
      ...cohortBinding,
      lifecycleState: options.lifecycleState ?? "RECOMMENDED",
      canaryRepositoryIds: options.canaryRepositoryIds ?? ["999999999"]
    }
  };
}

test("profile v3 schema rejects extra projected fields before desired-state interpretation", async () => {
  const valid = profile(cohort("source", "1.0.0"));
  await assert.doesNotReject(assertConsumerIntegrationProfileSchema(valid));
  await assert.rejects(assertConsumerIntegrationProfileSchema({ ...valid, unexpected: true }), /validation failed/u);
  await assert.rejects(assertConsumerIntegrationProfileSchema({ ...valid, cohort: { ...valid.cohort, unexpected: true } }), /validation failed/u);
});

const workspaceExclusions = (bytes) => parse(Buffer.from(bytes).toString("utf8"))
  .minimumReleaseAgeExclude;
const managedExclusions = (entries) => entries.filter((entry) =>
  entry.startsWith("@agent-teams/")
);

test("projects one explicit profile v3 and the three public entrypoint pins", async () => {
  const source = cohort("source", "1.0.0");
  const target = cohort("target", "2.0.0");
  const projectedProfile = JSON.parse(Buffer.from(
    await projectConsumerIntegrationProfileV3({
      bytes: Buffer.from(`${JSON.stringify(profile(source), null, 2)}\n`),
      cohort: target
    })
  ).toString("utf8"));
  assert.equal(projectedProfile.schemaVersion, 3);
  assert.deepEqual(projectedProfile.cohort, target);
  assert.deepEqual(projectedProfile.qualification, profile(source).qualification);

  const projectedManifest = JSON.parse(Buffer.from(projectPnpmManifestCohortPinsV2({
    bytes: Buffer.from(`${JSON.stringify({
      name: "consumer",
      private: true,
      devDependencies: { keep: "1.0.0" }
    }, null, 2)}\n`),
    cohort: target
  })).toString("utf8"));
  assert.deepEqual(projectedManifest.devDependencies, {
    keep: "1.0.0",
    "@agent-teams/docs-protocol": "2.0.0",
    "@agent-teams/docs-protocol-agent-teams": "2.0.0",
    "@agent-teams/engineering-foundation": "2.0.0"
  });
});

test("selects only a lifecycle-authorized Node26 Profile4 state before projection", () => {
  const source = profile(cohort("source", "1.0.0"));
  const target = cohort3("target", { sourceCohortId: source.cohort.cohortId });
  const selected = selectManagedSuccessorProfileV3(
    source,
    authority3(target),
    Date.parse("2026-10-14T00:00:00Z")
  );
  assert.equal(selected.status, "selected");
  assert.equal(selected.selection.profile.schemaVersion, 4);
  assert.equal(selected.selection.profile.cohort.schemaVersion, 3);
  assert.equal("lifecycleState" in selected.selection.profile.cohort, false);
  assert.deepEqual(selected.selection.profile.governedDocsRoots, source.governedDocsRoots);
  assert.equal(selected.selection.repositoryId, source.repository.id);

  for (const [description, authority, expected] of [
    ["QUALIFIED publication", authority3(target, { lifecycleState: "QUALIFIED" }),
      "DOCS_CONSUMER_COHORT_NOT_SELECTABLE"],
    ["denied canary repository", authority3(target, {
      lifecycleState: "CANARY", canaryRepositoryIds: ["123"]
    }), "DOCS_CONSUMER_COHORT_NOT_SELECTABLE"],
    ["future eligibility", authority3({
      ...target, eligibleAfter: "2099-01-01T00:00:00Z"
    }), "DOCS_CONSUMER_COHORT_NOT_ELIGIBLE"],
    ["missing source edge", authority3({
      ...target, upgradeFrom: ["other-source"], rollbackTo: ["other-source"]
    }), "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN"]
  ]) {
    const result = selectManagedSuccessorProfileV3(
      source,
      authority,
      Date.parse("2026-10-14T00:00:00Z")
    );
    assert.equal(result.status, "rejected", description);
    assert.equal(result.code, expected, description);
  }
});

test("projects Profile4 files with five-package, three-root and Node26 preimages", async () => {
  const source = profile(cohort("source", "1.0.0"));
  const target = cohort3("target", { sourceCohortId: source.cohort.cohortId });
  const selection = selectManagedSuccessorProfileV3(
    source,
    authority3(target),
    Date.parse("2026-10-14T00:00:00Z")
  );
  assert.equal(selection.status, "selected");
  const workspace = Buffer.from(`packages: []
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - '@agent-teams/docs-protocol@1.0.0'
  - '@agent-teams/docs-protocol-agent-teams@1.0.0'
  - '@agent-teams/engineering-foundation@1.0.0'
`);
  const projected = await projectConsumerUpgradeFiles({
    authority: authority3(target),
    current: source,
    manifest: Buffer.from(`${JSON.stringify(sourceManifestV2(source.cohort, source.profilePath), null, 2)}\n`),
    profile: Buffer.from(`${JSON.stringify(source, null, 2)}\n`),
    selection: selection.selection,
    workspace
  });
  const projectedProfile = JSON.parse(Buffer.from(projected.profile).toString("utf8"));
  assert.equal(projectedProfile.schemaVersion, 4);
  assert.deepEqual(projectedProfile.cohort, selection.selection.profile.cohort);
  assert.equal(Buffer.from(projected.nodeVersion).toString("utf8"), "26.11.1\n");
  const manifest = JSON.parse(Buffer.from(projected.manifest).toString("utf8"));
  assert.deepEqual(Object.keys(manifest.devDependencies).toSorted(), [
    "@agent-teams/docs-protocol",
    "@agent-teams/docs-protocol-agent-teams",
    "@agent-teams/engineering-foundation"
  ]);
  for (const bytes of [projected.profile, projected.manifest, projected.nodeVersion]) {
    assert.ok(bytes.byteLength > 0);
  }
  const targetEntries = [
    "repository-mutation", "document-authoring", "docs-protocol",
    "docs-protocol-agent-teams", "engineering-foundation"
  ].map((name) => `@agent-teams/${name}@2.0.0`);
  const committed = workspaceExclusions(projected.targetWorkspace);
  const migration = workspaceExclusions(projected.migrationWorkspace);
  assert.equal(managedExclusions(committed).length, 5);
  assert.equal(managedExclusions(migration).length, 10);
  for (const entry of targetEntries) {
    assert.equal(committed.filter((candidate) => candidate === entry).length, 1);
    assert.equal(migration.filter((candidate) => candidate === entry).length, 1);
  }
});

test("rejects a Cohort3 tuple that differs from packed policy before selection", () => {
  const source = profile(cohort("source", "1.0.0"));
  const target = cohort3("target", { sourceCohortId: source.cohort.cohortId });
  const repository = { provider: "github", id: "999999999", nameWithOwner: "agent-teams-ai/docs-v3-sandbox" };
  const registry = cohortV3Registry({ cohort: target, repository });
  registry.cohorts[0].runtime.qualification_runtime.node_version = "26.10.0";
  rebindCohortV3Registry(registry);
  assert.throws(
    () => projectCohortV3AuthorityBinding({
      cohortId: target.cohortId,
      registry,
      repository,
      revision: "8".repeat(40)
    }),
    /runtime differs/u
  );
});

test("stages source and target release-age evidence, then commits target-only authority", () => {
  const source = cohort("source", "1.0.0");
  const target = cohort("target", "2.0.0");
  const workspace = Buffer.from(`packages:\n  - packages/*\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - unrelated@3.0.0\n  - '@agent-teams/docs-protocol@1.0.0'\n`);
  const migration = Buffer.from(projectPnpmWorkspaceMigrationExclusionsV2({
    bytes: workspace,
    source,
    target
  })).toString("utf8");
  for (const packageName of [
    "repository-mutation",
    "document-authoring",
    "docs-protocol",
    "docs-protocol-agent-teams",
    "engineering-foundation"
  ]) {
    assert.match(migration, new RegExp(`@agent-teams/${packageName}@1\\.0\\.0`, "u"));
    assert.match(migration, new RegExp(`@agent-teams/${packageName}@2\\.0\\.0`, "u"));
  }
  const committed = Buffer.from(projectPnpmWorkspaceCohortExclusionsV2({
    bytes: workspace,
    cohort: target
  })).toString("utf8");
  assert.match(committed, /unrelated@3\.0\.0/u);
  assert.doesNotMatch(committed, /@agent-teams\/docs-protocol@1\.0\.0/u);
  assert.equal((committed.match(/@agent-teams\//gu) ?? []).length, 5);
});

test("profile v3 projection rejects implicit cross-generation input", async () => {
  const target = cohort("target", "2.0.0");
  const legacy = { ...profile(target), schemaVersion: 1 };
  await assert.rejects(
    projectConsumerIntegrationProfileV3({
      bytes: Buffer.from(`${JSON.stringify(legacy)}\n`),
      cohort: target
    }),
    (error) => error?.code === "DOCS_CONSUMER_UPGRADE_GENERATION_MISMATCH"
  );
});

test("upgrade file projection rejects cross-generation requests", async () => {
  const binding = cohort("target", "2.0.0");
  await assert.rejects(
    projectConsumerUpgradeFiles({
      authority: {
        repository: "agent-teams-ai/.github",
        path: "governance/docs-qualified-cohorts.json",
        revision: "a".repeat(40),
        cohort: binding
      },
      current: { ...profile(binding), schemaVersion: 1 },
      manifest: Buffer.from("{}\n"),
      profile: Buffer.from("{}\n")
    }),
    (error) => error?.code === "DOCS_CONSUMER_UPGRADE_GENERATION_MISMATCH"
  );
});

for (const sourceProfileVersion of [1, 2]) {
test(`migrates historical profile ${sourceProfileVersion} with exact source and target exclusions`, async () => {
  const target = {
    ...cohort("target", "2.0.0"),
    upgradeFrom: ["docs-v1-source"],
    rollbackTo: []
  };
  const source = {
    schemaVersion: 1,
    cohortId: "docs-v1-source",
    channel: "stable",
    recordDigest: `sha256:${"a".repeat(64)}`,
    qualificationEventDigest: `sha256:${"b".repeat(64)}`,
    eligibleAfter: "2026-09-03T00:00:00Z",
    upgradeFrom: [],
    rollbackTo: [],
    packages: {
      docsProtocol: coordinate("1.0.0"),
      engineeringFoundation: coordinate("1.0.0")
    },
    workflow: target.workflow,
    assets: target.assets,
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: target.runtime
  };
  const legacyProfile = {
    ...profile(target),
    schemaVersion: 1,
    cohort: source
  };
  delete legacyProfile.qualification;
  const sourceProfile = {
    ...legacyProfile,
    schemaVersion: sourceProfileVersion,
    ...(sourceProfileVersion === 2 ? { qualification: profile(target).qualification } : {})
  };
  const workspace = Buffer.from(`packages: []
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - unrelated@3.0.0
  - '@agent-teams/docs-protocol@1.0.0'
  - '@agent-teams/engineering-foundation@1.0.0'
`);
  const projectionInput = {
    authority: {
      repository: "agent-teams-ai/.github",
      path: "governance/docs-qualified-cohorts.json",
      revision: "c".repeat(40),
      cohort: target
    },
    current: legacyProfile,
    manifest: Buffer.from(`${JSON.stringify({
      name: "consumer",
      private: true,
      devDependencies: {
        "@agent-teams/docs-protocol": "1.0.0",
        "@agent-teams/engineering-foundation": "1.0.0"
      }
    })}\n`),
    profile: Buffer.from(`${JSON.stringify(sourceProfile, null, 2)}\r\n`),
    workspace
  };
  if (sourceProfileVersion === 2) {
    for (const qualification of [undefined, null, {}, {
      ...sourceProfile.qualification, gateCommand: "pnpm arbitrary:command"
    }]) {
      await assert.rejects(projectConsumerUpgradeFiles({
        ...projectionInput,
        profile: Buffer.from(JSON.stringify({ ...sourceProfile, qualification }))
      }), /docs-consumer-integration-profile-v2 validation failed/u);
    }
  }
  const projected = await projectConsumerUpgradeFiles(projectionInput);
  const projectedProfile = JSON.parse(Buffer.from(projected.profile).toString("utf8"));
  assert.equal(projectedProfile.schemaVersion, 3);
  assert.deepEqual(projectedProfile.cohort, target);
  assert.deepEqual(projectedProfile.qualification, profile(target).qualification);
  assert.deepEqual(projectedProfile.governedDocsRoots, sourceProfile.governedDocsRoots);
  const migration = workspaceExclusions(projected.migrationWorkspace);
  const committed = workspaceExclusions(projected.targetWorkspace);
  const targetEntries = [
    "repository-mutation", "document-authoring", "docs-protocol",
    "docs-protocol-agent-teams", "engineering-foundation"
  ].map((name) => `@agent-teams/${name}@2.0.0`);
  const sourceEntries = ["docs-protocol", "engineering-foundation"]
    .map((name) => `@agent-teams/${name}@1.0.0`);
  assert.equal(managedExclusions(migration).length, 7);
  assert.equal(managedExclusions(committed).length, 5);
  for (const entry of [...sourceEntries, ...targetEntries]) {
    assert.equal(migration.filter((candidate) => candidate === entry).length, 1);
  }
  for (const entry of targetEntries) {
    assert.equal(committed.filter((candidate) => candidate === entry).length, 1);
  }
  assert.deepEqual(committed.filter((entry) => sourceEntries.includes(entry)), []);
  assert.equal(migration.filter((entry) => entry === "unrelated@3.0.0").length, 1);
  assert.equal(committed.filter((entry) => entry === "unrelated@3.0.0").length, 1);
});
}

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
  projectPnpmManifestCohortPinsV2
} from "../dist/consumer-integration/adapters/pnpm-manifest-adapter-v2.js";

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

test("stages exact v1 and v2 exclusions but commits only v2 authority", async () => {
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
  const workspace = Buffer.from(`packages: []
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - unrelated@3.0.0
  - '@agent-teams/docs-protocol@1.0.0'
  - '@agent-teams/engineering-foundation@1.0.0'
`);
  const projected = await projectConsumerUpgradeFiles({
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
    profile: Buffer.from(`${JSON.stringify(legacyProfile)}\n`),
    workspace
  });
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

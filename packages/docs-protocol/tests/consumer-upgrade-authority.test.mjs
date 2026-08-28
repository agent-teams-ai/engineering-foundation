import assert from "node:assert/strict";
import test from "node:test";

import {
  assertConsumerUpgradeExecutionSchema
} from "../dist/consumer-integration/adapters/consumer-integration-schema-validator.js";
import {
  GitHubCohortAuthorityReader,
  projectQualifiedCohortAuthority
} from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";
import { sourceCohort } from "./consumer-upgrade-e2e-fixtures.mjs";

const REPOSITORY = {
  provider: "github",
  id: "999999999",
  nameWithOwner: "agent-teams-ai/docs-upgrade-sandbox"
};

function centralRegistry(cohort) {
  return {
    schema_version: 1,
    cohorts: [{
      cohort_id: cohort.cohortId,
      channel: cohort.channel,
      record_digest: cohort.recordDigest,
      eligible_after: cohort.eligibleAfter,
      upgrade_from: cohort.upgradeFrom,
      rollback_to: cohort.rollbackTo,
      packages: [
        { name: "@agent-teams/docs-protocol", ...cohort.packages.docsProtocol },
        {
          name: "@agent-teams/engineering-foundation",
          ...cohort.packages.engineeringFoundation
        }
      ],
      reusable_workflow: {
        repository: cohort.workflow.repository,
        path: cohort.workflow.path,
        revision: cohort.workflow.revision,
        blob_sha: cohort.workflow.blobSha
      },
      assets: {
        skill: { digest: cohort.assets.skillDigest },
        caller_workflow: { rendered_digest: cohort.assets.callerWorkflowDigest },
        asset_catalog: { digest: cohort.assets.assetCatalogDigest },
        transition_catalog: { digest: cohort.assets.transitionCatalogDigest }
      },
      schemas: {
        consumer_integration: cohort.schemas.consumerIntegration,
        managed_state: cohort.schemas.managedState,
        docs_protocol: cohort.schemas.docsProtocol
      },
      runtime: { node: cohort.runtime.node, pnpm: cohort.runtime.pnpm },
      runtime_closure: { digest: cohort.runtime.runtimeClosureDigest },
      canary_repositories: [{ repository_id: Number(REPOSITORY.id) }]
    }],
    events: [{
      sequence: 1,
      cohort_id: cohort.cohortId,
      state: "QUALIFIED",
      event_digest: cohort.qualificationEventDigest
    }, {
      sequence: 2,
      cohort_id: cohort.cohortId,
      state: "RECOMMENDED",
      event_digest: `sha256:${"9".repeat(64)}`
    }]
  };
}

test("binds authority reads to current protected main and rejects stale assertions", async () => {
  const { cohort } = await sourceCohort();
  const revision = "8".repeat(40);
  const registry = centralRegistry(cohort);
  const requests = [];
  const reader = new GitHubCohortAuthorityReader(async (url) => {
    requests.push(String(url));
    return String(url).endsWith("/commits/main")
      ? new Response(JSON.stringify({ sha: revision }))
      : new Response(JSON.stringify(registry));
  });
  const authority = await reader.read({
    cohortId: cohort.cohortId,
    repository: REPOSITORY,
    revision
  });
  assert.equal(authority.revision, revision);
  assert.deepEqual(requests, [
    "https://api.github.com/repos/agent-teams-ai/.github/commits/main",
    `https://raw.githubusercontent.com/agent-teams-ai/.github/${revision}/governance/docs-qualified-cohorts.json`
  ]);

  requests.length = 0;
  await assert.rejects(reader.read({
    cohortId: cohort.cohortId,
    repository: REPOSITORY,
    revision: "7".repeat(40)
  }), (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_REVISION_STALE");
  assert.deepEqual(requests, [
    "https://api.github.com/repos/agent-teams-ai/.github/commits/main"
  ]);
});

test("rejects ambiguous lifecycle sequencing and closes the upgrade envelope", async () => {
  const { cohort } = await sourceCohort();
  const registry = centralRegistry(cohort);
  registry.events[1].sequence = 1;
  assert.throws(() => projectQualifiedCohortAuthority({
    cohortId: cohort.cohortId,
    registry,
    repository: REPOSITORY,
    revision: "8".repeat(40)
  }), (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");

  await assertConsumerUpgradeExecutionSchema({
    schemaVersion: 1,
    command: "consumer.upgrade",
    outcome: "current",
    issues: []
  });
  await assert.rejects(assertConsumerUpgradeExecutionSchema({
    schemaVersion: 1,
    command: "consumer.upgrade",
    outcome: "current",
    issues: [],
    unexpected: true
  }), /validation failed/u);
});

test("rejects duplicate managed package authority", async () => {
  const { cohort } = await sourceCohort();
  const registry = centralRegistry(cohort);
  registry.cohorts[0].packages.push(structuredClone(registry.cohorts[0].packages[0]));
  assert.throws(() => projectQualifiedCohortAuthority({
    cohortId: cohort.cohortId,
    registry,
    repository: REPOSITORY,
    revision: "8".repeat(40)
  }), (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");
});

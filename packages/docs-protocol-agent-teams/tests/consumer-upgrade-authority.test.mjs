import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertConsumerUpgradeExecutionSchema
} from "../dist/consumer-integration/adapters/consumer-integration-schema-validator.js";
import {
  projectPnpmWorkspaceMigrationExclusionsV1
} from "../dist/consumer-integration/adapters/consumer-upgrade-file-projectors.js";
import {
  GitHubCohortAuthorityReader,
  projectQualifiedCohortAuthority
} from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";
import { projectDocsProtocolQualificationV3Authority } from
  "../dist/qualification/index.js";
import { sourceCohort } from "./consumer-upgrade-e2e-fixtures.mjs";

const REPOSITORY = {
  provider: "github",
  id: "999999999",
  nameWithOwner: "agent-teams-ai/docs-upgrade-sandbox"
};
const repositoryMutationReceiptSchema = JSON.parse(await readFile(new URL(
  import.meta.resolve("@agent-teams/repository-mutation/schemas/known-file-transaction-receipt/v1.schema.json")
), "utf8"));
const actualOrgV2Registry = JSON.parse(await readFile(new URL(
  "./fixtures/actual-org-cohort-v2.json", import.meta.url
), "utf8"));

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
      evidence_references: [],
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
        consumer_plan: 1,
        managed_state: cohort.schemas.managedState,
        foundation_plan: 1,
        foundation_journal: 1,
        foundation_receipt: 1,
        foundation_envelope: 5,
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

const V2_PACKAGE_NAMES = [
  ["repositoryMutation", "@agent-teams/repository-mutation"],
  ["documentAuthoring", "@agent-teams/document-authoring"],
  ["docsProtocol", "@agent-teams/docs-protocol"],
  ["docsProtocolAgentTeams", "@agent-teams/docs-protocol-agent-teams"],
  ["engineeringFoundation", "@agent-teams/engineering-foundation"]
];

function v2Cohort(source) {
  const coordinate = source.packages.docsProtocol;
  return {
    ...structuredClone(source),
    schemaVersion: 2,
    cohortId: "docs-cohort-v2-authority",
    packages: Object.fromEntries(V2_PACKAGE_NAMES.map(([key]) => [key, coordinate])),
    schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 }
  };
}

function v2Registry(cohort) {
  const registry = centralRegistry({
    ...cohort,
    packages: {
      docsProtocol: cohort.packages.docsProtocol,
      engineeringFoundation: cohort.packages.engineeringFoundation
    }
  });
  registry.cohorts[0].schemas = actualOrgV2Registry.cohorts[0].schemas;
  registry.cohorts[0].cohort_generation = 2;
  registry.cohorts[0].dependency_edges = actualOrgV2Registry.cohorts[0].dependency_edges;
  registry.cohorts[0].packages = V2_PACKAGE_NAMES.map(([key, name]) => ({
    name,
    ...cohort.packages[key]
  }));
  return registry;
}

test("projects the actual org Cohort v2 authority shape and rejects drift", () => {
  const input = {
    cohortId: actualOrgV2Registry.cohorts[0].cohort_id,
    registry: actualOrgV2Registry,
    repository: REPOSITORY,
    revision: "8".repeat(40)
  };
  const authority = projectDocsProtocolQualificationV3Authority(input);
  assert.equal(authority.cohort.schemaVersion, 2);
  assert.deepEqual(Object.keys(authority.cohort.packages), V2_PACKAGE_NAMES.map(([key]) => key));
  assert.deepEqual(authority.cohort.schemas, {
    consumerIntegration: 3, managedState: 2, docsProtocol: 1
  });
  for (const mutate of [
    (registry) => {registry.cohorts[0].dependency_edges.pop();},
    (registry) => {registry.cohorts[0].dependency_edges[0].to = "@agent-teams/docs-protocol";},
    (registry) => {delete registry.cohorts[0].schemas.qualification_receipt;},
    (registry) => {registry.cohorts[0].schemas.unexpected = 1;}
  ]) {
    const registry = structuredClone(actualOrgV2Registry);
    mutate(registry);
    assert.throws(() => projectDocsProtocolQualificationV3Authority({ ...input, registry }),
      (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");
  }
});

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
    generation: 1,
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
    generation: 1,
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
    generation: 1,
    registry,
    repository: REPOSITORY,
    revision: "8".repeat(40)
  }), (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");

  assert.equal(
    repositoryMutationReceiptSchema.properties.protocol.const,
    "agent-teams.repository-mutation.known-file/v1"
  );

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
    generation: 1,
    registry,
    repository: REPOSITORY,
    revision: "8".repeat(40)
  }), (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");
});

test("dispatches new authority only by its explicit per-record generation", async () => {
  const { cohort: source } = await sourceCohort();
  const cohort = v2Cohort(source);
  const input = {
    cohortId: cohort.cohortId,
    generation: 2,
    repository: REPOSITORY,
    revision: "8".repeat(40)
  };
  const registry = v2Registry(cohort);
  const authority = projectQualifiedCohortAuthority({ ...input, registry });
  assert.equal(authority.cohort.schemaVersion, 2);
  assert.deepEqual(authority.cohort.packages, cohort.packages);
  assert.deepEqual(projectDocsProtocolQualificationV3Authority({
    cohortId: input.cohortId,
    registry,
    repository: input.repository,
    revision: input.revision
  }), authority);

  const incompleteV2 = structuredClone(registry);
  incompleteV2.cohorts[0].packages.length = 2;
  assert.throws(() => projectQualifiedCohortAuthority({ ...input, registry: incompleteV2 }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");

  const fivePackageV1 = structuredClone(registry);
  delete fivePackageV1.cohorts[0].cohort_generation;
  fivePackageV1.cohorts[0].schemas = {
    consumer_integration: 1,
    managed_state: 1,
    docs_protocol: 1
  };
  assert.throws(() => projectQualifiedCohortAuthority({ ...input, registry: fivePackageV1 }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");

  const implicitLegacy = centralRegistry(source);
  assert.throws(() => projectQualifiedCohortAuthority({
    ...input, cohortId: source.cohortId, registry: implicitLegacy
  }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");
  assert.equal(projectQualifiedCohortAuthority({
    ...input,
    cohortId: source.cohortId,
    generation: 1,
    registry: implicitLegacy
  }).cohort.schemaVersion, 1);

  const unknownTuple = structuredClone(registry);
  unknownTuple.cohorts[0].schemas.managed_state = 3;
  assert.throws(() => projectQualifiedCohortAuthority({ ...input, registry: unknownTuple }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");

  const unknownGeneration = structuredClone(registry);
  unknownGeneration.cohorts[0].cohort_generation = 3;
  assert.throws(() => projectQualifiedCohortAuthority({ ...input, registry: unknownGeneration }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");

  const mixedGeneration = structuredClone(registry);
  mixedGeneration.cohorts[0].schemas = centralRegistry(source).cohorts[0].schemas;
  assert.throws(() => projectQualifiedCohortAuthority({ ...input, registry: mixedGeneration }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID");
});

test("temporarily exempts exact source and target package pins during lock migration", async () => {
  const { cohort: source } = await sourceCohort();
  const target = {
    ...structuredClone(source),
    packages: {
      ...structuredClone(source.packages),
      docsProtocol: { ...source.packages.docsProtocol, version: "9.8.7" }
    }
  };
  const workspace = `packages: []
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - "@agent-teams/docs-protocol@${source.packages.docsProtocol.version}"
  - "@agent-teams/engineering-foundation@${source.packages.engineeringFoundation.version}"
  - "unrelated@1.0.0"
`;
  const projected = Buffer.from(projectPnpmWorkspaceMigrationExclusionsV1({
    bytes: Buffer.from(workspace),
    source,
    target
  })).toString("utf8");
  assert.match(projected, new RegExp(
    `@agent-teams/docs-protocol@${source.packages.docsProtocol.version}`,
    "u"
  ));
  assert.match(projected, /@agent-teams\/docs-protocol@9\.8\.7/u);
  const foundation = `@agent-teams/engineering-foundation@${
    source.packages.engineeringFoundation.version
  }`;
  assert.equal(projected.split(foundation).length - 1, 1);
  assert.match(projected, /unrelated@1\.0\.0/u);
});

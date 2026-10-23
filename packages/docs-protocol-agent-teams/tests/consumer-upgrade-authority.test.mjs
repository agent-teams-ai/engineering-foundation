import { cohortDriftMutations } from "./consumer-authority-drift-mutations.ts";
import { canaryDriftMutations } from "./consumer-authority-canary-mutations.ts";
import {
  REPOSITORY,
  V2_PACKAGE_NAMES,
  authorityDigest,
  bindRegistry,
  centralRegistry,
} from "./consumer-authority-registry-fixture.ts";
import {
  actualOrgV2Registry,
  registerReconciliationAuthorityTests,
} from "./consumer-reconciliation-authority-cases.mjs";
import assert from "node:assert/strict";
import { registerRestorationAuthorityTest } from "./consumer-restoration-cases.mjs";

import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertConsumerUpgradeExecutionSchema } from "../dist/consumer-integration/adapters/consumer-integration-schema-validator.js";
import { projectPnpmWorkspaceMigrationExclusionsV1 } from "../dist/consumer-integration/adapters/consumer-upgrade-file-projectors.js";
import {
  GitHubCohortAuthorityReader,
  projectQualifiedCohortAuthority,
} from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";
import { projectDocsProtocolQualificationV3Authority } from "../dist/qualification/index.js";
import { sourceCohort } from "./consumer-upgrade-e2e-fixtures.mjs";

const repositoryMutationReceiptSchema = JSON.parse(
  await readFile(
    new URL(
      import.meta
        .resolve("@agent-teams/repository-mutation/schemas/repository-mutation/known-file-transaction-receipt/v1.schema.json"),
    ),
    "utf8",
  ),
);

bindRegistry(actualOrgV2Registry);

function v2Cohort(source) {
  const coordinate = source.packages.docsProtocol;
  return {
    ...structuredClone(source),
    schemaVersion: 2,
    cohortId: "docs-cohort-v2-authority",
    upgradeFrom: source.upgradeFrom.length === 0 ? ["docs-v1"] : source.upgradeFrom,
    packages: Object.fromEntries(V2_PACKAGE_NAMES.map(([key]) => [key, coordinate])),
    schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
  };
}

function v2Registry(cohort) {
  const registry = centralRegistry({
    ...cohort,
    packages: {
      docsProtocol: cohort.packages.docsProtocol,
      engineeringFoundation: cohort.packages.engineeringFoundation,
    },
  });
  const source = registry.cohorts[0];
  const current = actualOrgV2Registry.cohorts[0];
  source.schemas = structuredClone(current.schemas);
  source.cohort_generation = 2;
  source.dependency_edges = structuredClone(current.dependency_edges);
  source.packages = V2_PACKAGE_NAMES.map(([key], index) => {
    const coordinate = structuredClone(current.packages[index]);
    Object.assign(coordinate, cohort.packages[key]);
    coordinate.provenance.registry_attestation_url = `https://registry.npmjs.org/-/npm/v1/attestations/${coordinate.name.replaceAll(
      "/",
      "%2f",
    )}@${coordinate.version}`;
    return coordinate;
  });
  source.reusable_workflow = {
    ...structuredClone(current.reusable_workflow),
    revision: cohort.workflow.revision,
    blob_sha: cohort.workflow.blobSha,
  };
  source.assets = structuredClone(current.assets);
  source.assets.skill.digest = cohort.assets.skillDigest;
  source.assets.caller_workflow.rendered_digest = cohort.assets.callerWorkflowDigest;
  source.assets.asset_catalog.digest = cohort.assets.assetCatalogDigest;
  source.assets.transition_catalog.digest = cohort.assets.transitionCatalogDigest;
  source.runtime = structuredClone(current.runtime);
  source.runtime_closure = {
    ...structuredClone(current.runtime_closure),
    projection_path: `governance/docs-runtime-closures/${cohort.runtime.runtimeClosureDigest.replace(
      ":",
      "-",
    )}.json`,
    digest: cohort.runtime.runtimeClosureDigest,
  };
  source.canary_repositories = structuredClone(current.canary_repositories);
  source.evidence_references = ["test:synthetic-v2"];
  registry.events = [structuredClone(actualOrgV2Registry.events[0])];
  registry.events[0].cohort_id = cohort.cohortId;
  registry.events[0].event_digest = cohort.qualificationEventDigest;
  return bindRegistry(registry);
}

test("projects the actual org Cohort v2 authority shape and rejects drift", () => {
  const input = {
    cohortId: actualOrgV2Registry.cohorts[0].cohort_id,
    registry: actualOrgV2Registry,
    repository: REPOSITORY,
    revision: "8".repeat(40),
  };
  const authority = projectDocsProtocolQualificationV3Authority(input);
  assert.equal(authority.cohort.schemaVersion, 2);
  assert.deepEqual(
    Object.keys(authority.cohort.packages),
    V2_PACKAGE_NAMES.map(([key]) => key),
  );
  assert.deepEqual(authority.cohort.schemas, {
    consumerIntegration: 3,
    managedState: 2,
    docsProtocol: 1,
  });
  for (const mutate of [
    (registry) => {
      registry.cohorts[0].dependency_edges.pop();
    },
    (registry) => {
      registry.cohorts[0].dependency_edges[0].to = "@agent-teams/docs-protocol";
    },
    (registry) => {
      delete registry.cohorts[0].schemas.qualification_receipt;
    },
    (registry) => {
      registry.cohorts[0].schemas.unexpected = 1;
    },
  ]) {
    const registry = structuredClone(actualOrgV2Registry);
    mutate(registry);
    assert.throws(
      () => projectDocsProtocolQualificationV3Authority({ ...input, registry }),
      (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
    );
  }
});

registerReconciliationAuthorityTests({
  actualOrgV2Registry,
  authorityDigest,
  bindRegistry,
  REPOSITORY,
  V2_PACKAGE_NAMES,
});

test("fails closed on current Cohort v2 nested authority drift", () => {
  const input = {
    cohortId: actualOrgV2Registry.cohorts[0].cohort_id,
    repository: REPOSITORY,
    revision: "8".repeat(40),
  };
  const mutations = cohortDriftMutations();
  for (const [description, mutate] of mutations) {
    const registry = structuredClone(actualOrgV2Registry);
    mutate(registry.cohorts[0]);
    assert.throws(
      () => projectQualifiedCohortAuthority({ ...input, generation: 2, registry }),
      (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
      description,
    );
  }
  for (const [description, mutate] of [
    [
      "extra lifecycle event key",
      (event) => {
        event.unexpected = true;
      },
    ],
    [
      "missing lifecycle event key",
      (event) => {
        delete event.support_until;
      },
    ],
    [
      "duplicate lifecycle evidence reference",
      (event) => {
        event.evidence_references.push(event.evidence_references[0]);
      },
    ],
  ]) {
    const registry = structuredClone(actualOrgV2Registry);
    mutate(registry.events[0]);
    assert.throws(
      () => projectQualifiedCohortAuthority({ ...input, generation: 2, registry }),
      (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
      description,
    );
  }
});

test("rejects digest, global chain and CANARY semantic substitution", () => {
  const registry = structuredClone(actualOrgV2Registry);
  const source = registry.cohorts[0];
  const qualified = registry.events[0];
  registry.events.push({
    ...structuredClone(qualified),
    sequence: 2,
    state: "CANARY",
    canary_evidence: [
      {
        ...source.canary_repositories[0],
        merge_revision: "a".repeat(40),
        observed_cohort_id: source.cohort_id,
        observed_record_digest: source.record_digest,
        observed_event_digest: qualified.event_digest,
        required_context: "Docs Protocol",
        integration_id: 1,
        conclusion: "success",
        check_run_id: 22,
        check_run_url:
          "https://github.com/agent-teams-ai/docs-upgrade-sandbox/actions/runs/33/job/22",
        workflow_run_id: 33,
        workflow_id: 4,
        caller_workflow_path: ".github/workflows/docs.yml",
        caller_workflow_digest: source.assets.caller_workflow.rendered_digest,
      },
    ],
  });
  bindRegistry(registry);
  const project = (candidate) =>
    projectQualifiedCohortAuthority({
      cohortId: source.cohort_id,
      generation: 2,
      registry: candidate,
      repository: REPOSITORY,
      revision: "8".repeat(40),
    });
  assert.equal(project(registry).cohort.recordDigest, source.record_digest);
  const interleaved = structuredClone(registry);
  interleaved.events.splice(1, 0, {
    ...structuredClone(qualified),
    cohort_id: "unrelated-cohort",
    sequence: 2,
  });
  interleaved.events[2].sequence = 3;
  bindRegistry(interleaved);
  assert.equal(project(interleaved).cohort.cohortId, source.cohort_id);
  interleaved.events[1].event_digest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => project(interleaved),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
    "unselected global event corruption",
  );
  const invalidRecord = structuredClone(actualOrgV2Registry);
  invalidRecord.cohorts[0].record_digest = `sha256:${"c".repeat(64)}`;
  assert.throws(() => project(invalidRecord), /record_digest does not bind/u);
  const mutations = canaryDriftMutations();
  for (const [description, mutate] of mutations) {
    const candidate = structuredClone(registry);
    mutate(candidate);
    bindRegistry(candidate);
    assert.throws(
      () => project(candidate),
      (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
      description,
    );
  }
  for (const [description, mutate] of [
    [
      "arbitrary record digest",
      (value) => {
        value.cohorts[0].record_digest = `sha256:${"c".repeat(64)}`;
      },
    ],
    [
      "arbitrary event digest",
      (value) => {
        value.events[1].event_digest = `sha256:${"d".repeat(64)}`;
      },
    ],
    [
      "broken predecessor",
      (value) => {
        value.events[1].previous_event_digest = `sha256:${"e".repeat(64)}`;
        value.events[1].event_digest = authorityDigest(
          value.events[1],
          "event_digest",
          "agent-teams.docs-qualified-cohort-event/v1",
        );
      },
    ],
    [
      "global event reordering",
      (value) => {
        value.events.reverse();
      },
    ],
  ]) {
    const candidate = structuredClone(registry);
    mutate(candidate);
    assert.throws(
      () => project(candidate),
      (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
      description,
    );
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
    revision,
  });
  assert.equal(authority.revision, revision);
  assert.deepEqual(requests, [
    "https://api.github.com/repos/agent-teams-ai/.github/commits/main",
    `https://raw.githubusercontent.com/agent-teams-ai/.github/${revision}/governance/docs-qualified-cohorts.json`,
  ]);

  requests.length = 0;
  await assert.rejects(
    reader.read({
      cohortId: cohort.cohortId,
      generation: 1,
      repository: REPOSITORY,
      revision: "7".repeat(40),
    }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_REVISION_STALE",
  );
  assert.deepEqual(requests, ["https://api.github.com/repos/agent-teams-ai/.github/commits/main"]);
});

test("rejects ambiguous lifecycle sequencing and closes the upgrade envelope", async () => {
  const { cohort } = await sourceCohort();
  const registry = centralRegistry(cohort);
  registry.events[1].sequence = 1;
  assert.throws(
    () =>
      projectQualifiedCohortAuthority({
        cohortId: cohort.cohortId,
        generation: 1,
        registry,
        repository: REPOSITORY,
        revision: "8".repeat(40),
      }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
  );

  assert.equal(
    repositoryMutationReceiptSchema.properties.protocol.const,
    "agent-teams.repository-mutation.known-file/v1",
  );

  await assertConsumerUpgradeExecutionSchema({
    schemaVersion: 1,
    command: "consumer.upgrade",
    outcome: "current",
    issues: [],
  });
  await assert.rejects(
    assertConsumerUpgradeExecutionSchema({
      schemaVersion: 1,
      command: "consumer.upgrade",
      outcome: "current",
      issues: [],
      unexpected: true,
    }),
    /validation failed/u,
  );
});

test("rejects duplicate managed package authority", async () => {
  const { cohort } = await sourceCohort();
  const registry = centralRegistry(cohort);
  registry.cohorts[0].packages.push(structuredClone(registry.cohorts[0].packages[0]));
  assert.throws(
    () =>
      projectQualifiedCohortAuthority({
        cohortId: cohort.cohortId,
        generation: 1,
        registry,
        repository: REPOSITORY,
        revision: "8".repeat(40),
      }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
  );
});

test("dispatches new authority only by its explicit per-record generation", async () => {
  const { cohort: source } = await sourceCohort();
  const cohort = v2Cohort(source);
  const input = {
    cohortId: cohort.cohortId,
    generation: 2,
    repository: REPOSITORY,
    revision: "8".repeat(40),
  };
  const registry = v2Registry(cohort);
  const authority = projectQualifiedCohortAuthority({ ...input, registry });
  assert.equal(authority.cohort.schemaVersion, 2);
  assert.deepEqual(authority.cohort.packages, cohort.packages);
  assert.deepEqual(
    projectDocsProtocolQualificationV3Authority({
      cohortId: input.cohortId,
      registry,
      repository: input.repository,
      revision: input.revision,
    }),
    authority,
  );

  const incompleteV2 = structuredClone(registry);
  incompleteV2.cohorts[0].packages.length = 2;
  assert.throws(
    () => projectQualifiedCohortAuthority({ ...input, registry: incompleteV2 }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
  );

  const fivePackageV1 = structuredClone(registry);
  delete fivePackageV1.cohorts[0].cohort_generation;
  fivePackageV1.cohorts[0].schemas = {
    consumer_integration: 1,
    managed_state: 1,
    docs_protocol: 1,
  };
  assert.throws(
    () => projectQualifiedCohortAuthority({ ...input, registry: fivePackageV1 }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
  );

  const implicitLegacy = centralRegistry(source);
  assert.throws(
    () =>
      projectQualifiedCohortAuthority({
        ...input,
        cohortId: source.cohortId,
        registry: implicitLegacy,
      }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
  );
  assert.equal(
    projectQualifiedCohortAuthority({
      ...input,
      cohortId: source.cohortId,
      generation: 1,
      registry: implicitLegacy,
    }).cohort.schemaVersion,
    1,
  );

  const unknownTuple = structuredClone(registry);
  unknownTuple.cohorts[0].schemas.managed_state = 3;
  assert.throws(
    () => projectQualifiedCohortAuthority({ ...input, registry: unknownTuple }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
  );

  const unknownGeneration = structuredClone(registry);
  unknownGeneration.cohorts[0].cohort_generation = 3;
  assert.throws(
    () => projectQualifiedCohortAuthority({ ...input, registry: unknownGeneration }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
  );

  const mixedGeneration = structuredClone(registry);
  mixedGeneration.cohorts[0].schemas = centralRegistry(source).cohorts[0].schemas;
  assert.throws(
    () => projectQualifiedCohortAuthority({ ...input, registry: mixedGeneration }),
    (error) => error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID",
  );
});

test("temporarily exempts exact source and target package pins during lock migration", async () => {
  const { cohort: source } = await sourceCohort();
  const target = {
    ...structuredClone(source),
    packages: {
      ...structuredClone(source.packages),
      docsProtocol: { ...source.packages.docsProtocol, version: "9.8.7" },
    },
  };
  const workspace = `packages: []
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - "@agent-teams/docs-protocol@${source.packages.docsProtocol.version}"
  - "@agent-teams/engineering-foundation@${source.packages.engineeringFoundation.version}"
  - "unrelated@1.0.0"
`;
  const projected = Buffer.from(
    projectPnpmWorkspaceMigrationExclusionsV1({
      bytes: Buffer.from(workspace),
      source,
      target,
    }),
  ).toString("utf8");
  assert.match(
    projected,
    new RegExp(`@agent-teams/docs-protocol@${source.packages.docsProtocol.version}`, "u"),
  );
  assert.match(projected, /@agent-teams\/docs-protocol@9\.8\.7/u);
  const foundation = `@agent-teams/engineering-foundation@${
    source.packages.engineeringFoundation.version
  }`;
  assert.equal(projected.split(foundation).length - 1, 1);
  assert.match(projected, /unrelated@1\.0\.0/u);
});

registerRestorationAuthorityTest({
  sourceCohort,
  v2Cohort,
  centralRegistry,
  v2Registry,
  authorityDigest,
  REPOSITORY,
});

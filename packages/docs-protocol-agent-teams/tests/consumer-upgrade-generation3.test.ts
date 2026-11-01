import { projectManagedGenerationRuntime } from "../dist/consumer-integration/adapters/managed-generation-projectors.js";
import { planPnpmManifestV2 } from "../dist/index.js";
import {
  successorCentralRegistryFixture,
  authorityDigest,
} from "./public-managed-registry-canary-generation3-fixtures.ts";
import {
  GitHubCohortAuthorityReader,
  projectQualifiedCohortAuthority,
} from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desired, file } from "./consumer-plan-v3-fixture.ts";
import { compileConsumerIntegration } from "../dist/consumer-integration/application/use-cases/plan-consumer-integration.js";
import { createConsumerIntegrationUseCases } from "../dist/consumer-integration/application/use-cases/run-consumer-integration.js";
import { createConsumerUpgradeUseCase } from "../dist/consumer-integration/application/use-cases/upgrade-consumer-integration.js";
import { consumerIntegrationPlanningPorts } from "../dist/consumer-integration/composition/consumer-integration-planner.js";
import { foundationKnownFileTransaction } from "../dist/consumer-integration/composition/known-file-transaction.js";
import { packageConsumerAssetCatalogReader } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import { projectConsumerUpgradeFiles } from "../dist/consumer-integration/adapters/consumer-upgrade-file-projectors.js";
import { managedUpgradeRuntime } from "../dist/consumer-integration/adapters/node-consumer-upgrade-runtime.js";
import type { ConsumerUpgradeAuthorityV2 } from "../dist/consumer-integration/domain/model.js";
import {
  assertOriginalCliSelections,
  assertCurrentCliSelections,
  revision,
  target,
  selected,
  manifest,
  currentSnapshot,
  forbidden,
  fixture,
} from "./consumer-upgrade-generation3-fixture.ts";

void test("profile4 ordinary check/plan/apply runs the actual cohort3 manifest planner without historical catalogs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "TEST-managed-lifecycle3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = target();
  const before = currentSnapshot(profile);
  const lifecycle = createConsumerIntegrationUseCases({
    input: {
      read: async () => ({
        root,
        desired: profile,
        snapshot: before,
      }),
    },
    planning: consumerIntegrationPlanningPorts,
    assets: {
      read: async () => {
        throw new Error("Profile4 must not read legacy catalogs");
      },
    },
    transaction: foundationKnownFileTransaction,
  });
  // check/plan are read-only; no filesystem transaction is requested for an already current profile.
  const plan = await lifecycle.plan({ consumerRoot: root, to: profile.cohort.cohortId });
  assert.equal(plan.outcome, "current");
  assert.ok(plan.plan);
  if (process.platform === "win32") {
    await assert.rejects(lifecycle.apply({ consumerRoot: root, expect: plan.plan.planDigest }), {
      code: "KNOWN_FILE_APPLY_UNSUPPORTED",
    });
  } else {
    assert.equal(
      (await lifecycle.apply({ consumerRoot: root, expect: plan.plan.planDigest })).outcome,
      "current",
    );
  }
  assert.equal((await lifecycle.check({ consumerRoot: root })).outcome, "current");
  const modified = { ...before, managedState: file("foreign") };
  assert.equal(
    compileConsumerIntegration(
      { desired: profile, snapshot: modified },
      consumerIntegrationPlanningPorts,
    ).plan.outcome,
    "blocked",
  );
});

void test("generation2-to3 refuses unretained synchronous publication before staging or activation", async (t) => {
  const f = await fixture(t);
  const result = await f.upgrade({
    consumerRoot: f.root,
    to: f.successor.cohort.cohortId,
    targetGeneration: 3,
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.issues[0]?.code, "DOCS_CONSUMER_RESTORATION_PROOF_REQUIRED");
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(join(f.root, ".node-version"), "utf8"), "24.21.0\n");
});

void test("explicit retained2-to3 preparation never activates or writes the consumer", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "..", "TEST-retained-selection");
  const upgrade = createConsumerUpgradeUseCase({
    ...f.ports,
    restoration: {
      prepare: forbidden,
      prepareManaged: async (options) => {
        assert.equal(options.current.schemaVersion, 3);
        assert.equal(options.target.schemaVersion, 3);
        assert.equal(options.plan.operations[0]?.path, ".node-version");
        return { path, digest: `sha256:${"3".repeat(64)}` };
      },
    },
  });
  const result = await upgrade({
    consumerRoot: f.root,
    to: f.successor.cohort.cohortId,
    targetGeneration: 3,
    sourceGeneration: 2,
    prepare: true,
    restorationProofPath: path,
  });
  assert.equal(result.outcome, "prepared");
  assert.equal(result.preparation?.path, path);
  assert.deepEqual(f.calls, ["prepare"]);
  assert.equal(await readFile(join(f.root, ".node-version"), "utf8"), "24.21.0\n");
});

void test("authority drift after staging refuses publication and omitted explicit generation remains blocked", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const upgrade = createConsumerUpgradeUseCase({
    ...f.ports,
    restoration: { prepare: forbidden, prepareManaged: forbidden },
    authority: {
      read: async () => ({ ...f.authority, revision: ++reads === 1 ? revision : "b".repeat(40) }),
    },
  });
  assert.equal(
    (
      await upgrade({
        consumerRoot: f.root,
        to: f.successor.cohort.cohortId,
        targetGeneration: 3,
        sourceGeneration: 2,
        prepare: true,
        restorationProofPath: join(f.root, "..", "TEST-drift-selection"),
      })
    ).outcome,
    "blocked",
  );
  assert.deepEqual(f.calls, ["prepare"]);
  assert.equal(await readFile(join(f.root, ".node-version"), "utf8"), "24.21.0\n");
  assert.equal(
    (await f.upgrade({ consumerRoot: f.root, to: f.successor.cohort.cohortId })).outcome,
    "blocked",
  );
});

void test("managed generation projects a coherent exact pnpm engine while preserving unrelated manifest bytes", () => {
  const before =
    '{\n  "name": "consumer",\n  "packageManager": "pnpm@11.18.0",\n' +
    '  "engines": { "node": "24.21.0", "pnpm": "11.18.0", "npm": ">=11" },\n' +
    '  "scripts": { "check": "node check.js" },\n  "custom": { "spacing":  true }\n}\n';
  const projected = Buffer.from(
    projectManagedGenerationRuntime(Buffer.from(before), "26.11.1"),
  ).toString("utf8");
  const expected = before
    .replace("pnpm@11.18.0", "pnpm@11.20.0")
    .replace('"pnpm": "11.18.0"', '"pnpm": "11.20.0"')
    .replace('"node": "24.21.0"', '"node": "26.11.1"');
  assert.equal(projected, expected);
  const absent = before.replace(', "pnpm": "11.18.0"', "");
  assert.equal(
    Buffer.from(projectManagedGenerationRuntime(Buffer.from(absent), "26.11.1")).toString("utf8"),
    absent
      .replace("pnpm@11.18.0", "pnpm@11.20.0")
      .replace('"node": "24.21.0"', '"node": "26.11.1"'),
  );
  assert.equal(
    Buffer.from(projectManagedGenerationRuntime(Buffer.from(projected), "24.21.0")).toString(
      "utf8",
    ),
    expected.replace('"node": "26.11.1"', '"node": "24.21.0"'),
  );
});

void test("managed forward and explicit rollback project only schema/cohort and closed runtime fields", async () => {
  const source = desired(),
    successor = target();
  const bytes = Buffer.from(JSON.stringify(manifest(source)));
  const forward = await projectConsumerUpgradeFiles({
    current: source,
    authority: selected(successor),
    manifest: bytes,
    profile: Buffer.from(JSON.stringify(source)),
  });
  const projected: unknown = JSON.parse(Buffer.from(forward.profile).toString("utf8"));
  assert.ok(typeof projected === "object" && projected !== null && "schemaVersion" in projected);
  assert.equal(projected.schemaVersion, 4);
  assert.equal(Buffer.from(forward.nodeVersion!).toString("utf8"), "26.11.1\n");
  const authority: ConsumerUpgradeAuthorityV2 = {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision,
    cohort: source.cohort,
  };
  const rollback = await projectConsumerUpgradeFiles({
    current: successor,
    authority,
    manifest: forward.manifest,
    profile: forward.profile,
  });
  const restored: unknown = JSON.parse(Buffer.from(rollback.profile).toString("utf8"));
  assert.deepEqual(restored, source);
  assert.equal(Buffer.from(rollback.nodeVersion!).toString("utf8"), "24.21.0\n");
  assert.deepEqual(JSON.parse(Buffer.from(rollback.manifest).toString("utf8")), manifest(source));
});

void test("generation3 runtime selection refuses missing executables before any install or CLI effect", async () => {
  const { NodeConsumerUpgradeSandbox } =
    await import("../dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js");
  await assert.rejects(
    new NodeConsumerUpgradeSandbox(() => ({})).verifyManagedRuntime({
      cohort: selected(target()).cohort,
      packageManager: "pnpm@11.20.0",
    }),
    { code: "DOCS_CONSUMER_UPGRADE_RUNTIME_REQUIRED" },
  );

  await assert.rejects(
    managedUpgradeRuntime(target().cohort, "/TEST-only", () => ({})),
    { code: "DOCS_CONSUMER_UPGRADE_RUNTIME_REQUIRED" },
  );
});

void test("stable31 historical bundle binds the real retained origin and exact Skill/caller bytes", async () => {
  const catalog = await packageConsumerAssetCatalogReader.read();
  const origin = catalog.historicalV2Bundles?.find(
    ({ cohort }) => cohort.cohortId === "docs-2026-10-03-stable31",
  );
  assert.ok(origin);
  assert.equal(
    origin.cohort.recordDigest,
    "sha256:15ef4d89c312593f5ecee9e0c9890f4ffa487e4d869682dec688460f2f4fc0c8",
  );
  assert.equal(
    origin.cohort.qualificationEventDigest,
    "sha256:7273eab4e9b555bde22a2c89f4b98735c0d668afb6144b5983e030ee942c420f",
  );
  const source = { ...desired(), cohort: origin.cohort };
  const initial = currentSnapshot(source, catalog);
  const proof = compileConsumerIntegration(
    { desired: source, snapshot: initial, assetCatalog: catalog },
    consumerIntegrationPlanningPorts,
  );
  assert.equal(proof.plan.outcome, "current");
});

void test("generation3 selected authority keeps exact enrollment and rejects protected-main drift", async () => {
  const f = successorCentralRegistryFixture();
  const selection = projectQualifiedCohortAuthority({
    ...f,
    cohortId: f.cohort.cohortId,
    generation: 3,
  });
  assert.equal(selection.cohort.schemaVersion, 3);
  assert.deepEqual(selection.cohort.packages, f.cohort.packages);
  const wrong = structuredClone(f.registry);
  const records: unknown = wrong["cohorts"];
  assert.ok(Array.isArray(records));
  const source: unknown = records[0];
  assert.ok(typeof source === "object" && source !== null && !Array.isArray(source));
  const changed: Record<string, unknown> = Object.fromEntries(Object.entries(source));
  changed["canary_repositories"] = [
    { repository_id: 1, repository: "agent-teams-ai/foreign-TEST" },
  ];
  delete changed["record_digest"];
  changed["record_digest"] = authorityDigest("agent-teams.docs-qualified-cohort/v3", changed);
  wrong["cohorts"] = [changed];
  assert.throws(
    () =>
      projectQualifiedCohortAuthority({
        ...f,
        registry: wrong,
        cohortId: f.cohort.cohortId,
        generation: 3,
      }),
    { code: "DOCS_CONSUMER_COHORT_NOT_SELECTABLE" },
  );
  let protectedHead = f.revision;
  const reader = new GitHubCohortAuthorityReader(
    async (url) =>
      new Response(
        JSON.stringify(
          (url instanceof Request ? url.url : url.toString()).endsWith("commits/main")
            ? { sha: f.revision }
            : (url instanceof Request ? url.url : url.toString()).endsWith("branches/main")
              ? { protected: true, commit: { sha: protectedHead } }
              : f.registry,
        ),
      ),
  );
  assert.equal(
    (
      await reader.read({
        cohortId: f.cohort.cohortId,
        generation: 3,
        repository: f.repository,
        revision: f.revision,
      })
    ).cohort.schemaVersion,
    3,
  );
  protectedHead = "f".repeat(40);
  await assert.rejects(
    reader.read({
      cohortId: f.cohort.cohortId,
      generation: 3,
      repository: f.repository,
      revision: f.revision,
    }),
    { code: "DOCS_CONSUMER_AUTHORITY_REVISION_STALE" },
  );
});

void test("unselected3-to2 upgrade refuses publication and requires the original preparation selector", async (t) => {
  const current = target(),
    origin = desired();
  const authority: ConsumerUpgradeAuthorityV2 = {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision,
    cohort: origin.cohort,
  };
  const f = await fixture(t, { current, authority });
  const result = await f.upgrade({
    consumerRoot: f.root,
    to: origin.cohort.cohortId,
    targetGeneration: 2,
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.issues[0]?.code, "DOCS_CONSUMER_RESTORATION_PROOF_REQUIRED");
  const future = await f.upgrade({
    consumerRoot: f.root,
    to: "docs-unadmitted-future3",
    targetGeneration: 3,
  });
  assert.equal(future.outcome, "blocked");
  assert.equal(future.issues[0]?.code, "DOCS_CONSUMER_RESTORATION_PROOF_REQUIRED");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.reads, []);
  assert.equal(await readFile(join(f.root, ".node-version"), "utf8"), "26.11.1\n");
});

void test("runtime observation rejects the actual wrong Node major before running the manager", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "TEST-managed-runtime-rejection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cohort = process.versions.node.startsWith("26.") ? desired().cohort : target().cohort;
  const major = cohort.schemaVersion === 3 ? 26 : 24;
  await assert.rejects(
    managedUpgradeRuntime(cohort, root, () => ({
      [`AGENT_TEAMS_DOCS_UPGRADE_NODE${major}_EXECUTABLE`]: process.execPath,
      AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT: process.execPath,
    })),
    { code: "DOCS_CONSUMER_UPGRADE_RUNTIME_INVALID" },
  );
});

void test("proof-selected rollback validates the complete suspended source binding without granting new selection", async () => {
  const f = successorCentralRegistryFixture();
  const { assertManagedRollbackSource } =
    await import("../dist/consumer-integration/adapters/cohort-rollback-authority.js");
  const { projectCohortV3Authority, projectCohortV3Binding } =
    await import("../dist/consumer-integration/adapters/cohort-v3-authority-projector.js");
  const events: unknown = f.registry["events"];
  assert.ok(Array.isArray(events));
  const last: unknown = events.at(-1);
  assert.ok(typeof last === "object" && last !== null && "event_digest" in last);
  const body = {
    sequence: 3,
    cohort_id: f.cohort.cohortId,
    state: "SUSPENDED",
    effective_at: "2026-10-13T00:00:00Z",
    support_until: null,
    evidence_references: ["test:suspended"],
    canary_evidence: [],
    previous_event_digest: last.event_digest,
  };
  events.push({
    ...body,
    event_digest: authorityDigest("agent-teams.docs-qualified-cohort-event/v1", body),
  });
  const input = {
    registry: f.registry,
    revision: f.revision,
    repository: f.repository,
    cohortId: f.cohort.rollbackTo[0]!,
    rollbackFrom: f.cohort.cohortId,
    now: Date.parse("2026-10-14T00:00:00Z"),
  };
  assert.doesNotThrow(() => {
    assertManagedRollbackSource(input);
  });
  assert.throws(
    () => projectCohortV3Authority({ ...f, cohortId: f.cohort.cohortId }),
    /unselected current state/u,
  );
  const binding = projectCohortV3Binding({ ...f, cohortId: f.cohort.cohortId });
  const expected = {
    ...binding,
    recordDigest: `sha256:${binding.recordDigest.slice(7)}` as const,
    qualificationEventDigest: `sha256:${binding.qualificationEventDigest.slice(7)}` as const,
  };
  assert.doesNotThrow(() => {
    assertManagedRollbackSource({ ...input, expected });
  });
  const altered = {
    ...expected,
    packages: {
      ...expected.packages,
      docsProtocol: { ...expected.packages.docsProtocol, version: "99.0.0" },
    },
  };
  assert.throws(() => {
    assertManagedRollbackSource({ ...input, expected: altered });
  }, /source binding changed/u);
  assert.throws(
    () => {
      assertManagedRollbackSource({ ...input, repository: { ...f.repository, id: "1" } });
    },
    { code: "DOCS_CONSUMER_COHORT_NOT_SELECTABLE" },
  );
});

void test(
  "CLI finalization/restoration require explicit generations and their own selection family",
  assertOriginalCliSelections,
);
void test(
  "CLI committed-target restore requires complete exact current selection inputs",
  assertCurrentCliSelections,
);

void test("public manifest V2 preserves qualified inputs and accepts exact package projections", () => {
  const source = desired();
  const input = {
    observation: file(JSON.stringify(manifest(source))),
    profilePath: source.profilePath,
  };
  const qualified = planPnpmManifestV2({ ...input, cohort: source.cohort });
  const packagesOnly = planPnpmManifestV2({
    ...input,
    cohort: { packages: source.cohort.packages },
  });
  assert.equal(qualified.issues.length, 0);
  assert.deepEqual(packagesOnly, qualified);
  const successor = target();
  const generation3 = planPnpmManifestV2({
    observation: file(JSON.stringify(manifest(successor))),
    profilePath: successor.profilePath,
    cohort: { packages: successor.cohort.packages },
  });
  assert.equal(generation3.issues.length, 0);
  const missingPackagesRejected: Record<PropertyKey, never> extends Parameters<
    typeof planPnpmManifestV2
  >[0]["cohort"]
    ? false
    : true = true;
  assert.equal(missingPackagesRejected, true);
});

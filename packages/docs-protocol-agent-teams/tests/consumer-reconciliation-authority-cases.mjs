import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { projectQualifiedCohortAuthority } from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";

export const actualOrgV2Registry = JSON.parse(await readFile(new URL(
  "./fixtures/actual-org-cohort-v2.json", import.meta.url
), "utf8"));

// Exact stable12 record from the sealed authority audit; never rebind its digest.
const actualStable12 = JSON.parse(await readFile(new URL(
  "./fixtures/actual-stable12-cohort-v2.json", import.meta.url
), "utf8"));

export function registerReconciliationAuthorityTests({ actualOrgV2Registry: registryFixture, authorityDigest, bindRegistry, REPOSITORY, V2_PACKAGE_NAMES }) {
  function reconciliationRegistry() {
    // One synthetic QUALIFIED event avoids copying the unrelated global ledger.
    const event = { ...structuredClone(registryFixture.events[0]),
      cohort_id: actualStable12.cohort_id };
    event.event_digest = authorityDigest(event, "event_digest", "agent-teams.docs-qualified-cohort-event/v1");
    return { schema_version: 1, cohorts: [structuredClone(actualStable12)], events: [event] };
  }
  function projectReconciliation(registry) {
    const source = registry.cohorts[0];
    return projectQualifiedCohortAuthority({
      cohortId: source.cohort_id, generation: 2, registry, revision: "8".repeat(40),
      repository: { ...REPOSITORY, id: String(source.canary_repositories[0].repository_id),
        nameWithOwner: source.canary_repositories[0].repository }
    });
  }

  test("projects exact central reconciliation provenance with its original full digest", () => {
    const registry = reconciliationRegistry();
    const before = structuredClone(registry);
    const authority = projectReconciliation(registry);
    assert.equal(authority.cohort.recordDigest,
      "sha256:9cd6951900b838bdec78685d00d569f1a5e5a838dcf8f5836b6ec491c9b665fd");
    assert.equal(authority.cohort.qualificationEventDigest, registry.events[0].event_digest);
    assert.deepEqual(authority.cohort.packages, Object.fromEntries(
      V2_PACKAGE_NAMES.map(([key], index) => {
        const { version, integrity } = actualStable12.packages[index];
        return [key, { version, integrity }];
      })
    ));
    for (const coordinate of registry.cohorts[0].packages.slice(0, 4)) {
      assert.equal(coordinate.provenance.workflow_run_attempt, 1);
      assert.deepEqual(coordinate.provenance.reconciliation,
        { workflow_run_attempt: 2, release_job_id: 101813993229 });
    }
    assert.deepEqual(registry, before);
  });

  test("accepts legacy nine-field provenance and positive reconciliation without attempt ordering", () => {
    const legacy = structuredClone(registryFixture);
    assert.ok(legacy.cohorts[0].packages.every((entry) => Object.keys(entry.provenance).length === 9));
    assert.equal(projectReconciliation(legacy).cohort.recordDigest, legacy.cohorts[0].record_digest);
    for (const attempt of [1, 3, Number.MAX_SAFE_INTEGER]) {
      const registry = reconciliationRegistry();
      const provenance = registry.cohorts[0].packages[0].provenance;
      provenance.workflow_run_attempt = 3;
      provenance.reconciliation = { workflow_run_attempt: attempt, release_job_id: attempt };
      bindRegistry(registry);
      assert.equal(projectReconciliation(registry).cohort.recordDigest, registry.cohorts[0].record_digest);
    }
  });

  test("rejects malformed reconciliation and retains all original provenance guards", () => {
    const mutations = [
      ["unknown outer key", (value) => {value.unexpected = true;}],
      ...Object.keys(actualStable12.packages[0].provenance).filter((key) => key !== "reconciliation")
        .map((key) => [`missing ${key}`, (value) => {delete value[key];}]),
      ["source repository", (value) => {value.source_repository = "agent-teams-ai/other";}],
      ["repository ID", (value) => {value.source_repository_id++;}],
      ["signature", (value) => {value.signature_verified = false;}],
      ["source commit", (value) => {value.source_commit = "0".repeat(40);}],
      ["source workflow", (value) => {value.source_workflow = "../release.yml";}],
      ["run URL", (value) => {value.workflow_run_url += "1";}],
      ["attestation URL", (value) => {value.registry_attestation_url += "1";}],
      ["original attempt", (value) => {value.workflow_run_attempt = 0;}],
      ["original run ID", (value) => {value.workflow_run_id = 0;}],
      ["unknown nested key", (value) => {value.reconciliation.unexpected = true;}],
      ...[null, [], "reconciled", true, 2, {}].map((entry) =>
        [`nested shape ${JSON.stringify(entry)}`, (value) => {value.reconciliation = entry;}]),
      ...["workflow_run_attempt", "release_job_id"].flatMap((key) => [
        [`missing ${key}`, (value) => {delete value.reconciliation[key];}],
        ...[null, "2", true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, [], {}].map((entry) =>
          [`${key} ${JSON.stringify(entry)}`, (value) => {value.reconciliation[key] = entry;}])
      ])
    ];
    for (const [description, mutate] of mutations) {
      const registry = reconciliationRegistry();
      mutate(registry.cohorts[0].packages[0].provenance);
      // Valid digests ensure shape failures cannot pass solely through digest rejection.
      bindRegistry(registry);
      assert.throws(() => projectReconciliation(registry), (error) =>
        error?.code === "DOCS_CONSUMER_AUTHORITY_INVALID", description);
    }
    for (const entry of [null, [], "provenance", true]) {
      const registry = reconciliationRegistry();
      registry.cohorts[0].packages[0].provenance = entry;
      bindRegistry(registry);
      assert.throws(() => projectReconciliation(registry), /provenance must be one plain object/u);
    }
    for (const key of ["workflow_run_attempt", "release_job_id"]) {
      for (const entry of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        const registry = reconciliationRegistry();
        registry.cohorts[0].packages[0].provenance.reconciliation[key] = entry;
        assert.throws(() => projectReconciliation(registry), /must be one positive safe integer/u);
      }
    }
    for (const entry of [undefined, new Date(0), Object.create(null),
      Object.assign(Object.create({ inherited: true }), { workflow_run_attempt: 2, release_job_id: 1 })]) {
      const registry = reconciliationRegistry();
      registry.cohorts[0].packages[0].provenance.reconciliation = entry;
      assert.throws(() => projectReconciliation(registry), /reconciliation must be one plain object/u);
    }
  });

  test("rejects reconciliation removal or mutation retaining the authoritative record digest", () => {
    for (const mutate of [
      (value) => {delete value.reconciliation;},
      (value) => {value.reconciliation.workflow_run_attempt++;},
      (value) => {value.reconciliation.release_job_id++;}
    ]) {
      const registry = reconciliationRegistry();
      mutate(registry.cohorts[0].packages[0].provenance);
      assert.equal(registry.cohorts[0].record_digest, actualStable12.record_digest);
      assert.throws(() => projectReconciliation(registry), /record_digest does not bind/u);
    }
  });
}

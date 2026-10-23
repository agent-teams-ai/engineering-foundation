import assert from "node:assert/strict";
import test from "node:test";
import {
  type QualifiedDocsCohortBindingV1,
  type QualifiedDocsCohortBindingV2,
} from "../dist/consumer-integration/index.js";
import { assertRestorationAuthority } from "../dist/consumer-integration/adapters/node-consumer-restoration.js";
import {
  GitHubCohortAuthorityReader,
  projectQualifiedCohortAuthority,
} from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";
import {
  type centralRegistry,
  type authorityDigest,
} from "./consumer-authority-registry-fixture.ts";
type RegistryCohort = Parameters<typeof centralRegistry>[0];
type MutableRegistryCohort = {
  -readonly [K in keyof QualifiedDocsCohortBindingV2]: QualifiedDocsCohortBindingV2[K];
};
interface RegistryEvent extends Record<string, unknown> {
  sequence: number;
  cohort_id: string;
  state: string;
  event_digest: string;
  previous_event_digest?: string | null;
  support_until?: string;
}
type Registry = {
  schema_version: number;
  cohorts: ReturnType<typeof centralRegistry>["cohorts"];
  events: RegistryEvent[];
};
interface RestorationAuthorityHelpers {
  sourceCohort: () => Promise<{ cohort: QualifiedDocsCohortBindingV1 }>;
  v2Cohort: (source: QualifiedDocsCohortBindingV1) => MutableRegistryCohort;
  centralRegistry: typeof centralRegistry;
  v2Registry: (source: RegistryCohort) => ReturnType<typeof centralRegistry>;
  authorityDigest: typeof authorityDigest;
  REPOSITORY: { provider: "github"; id: string; nameWithOwner: string };
}
function bindRestorationEvents(
  registry: Registry,
  authorityDigest: RestorationAuthorityHelpers["authorityDigest"],
) {
  let previous: string | null = null;
  registry.events.forEach((event, index) => {
    event.sequence = index + 1;
    event.previous_event_digest = previous;
    event.event_digest = authorityDigest(
      event,
      "event_digest",
      "agent-teams.docs-qualified-cohort-event/v1",
    );
    previous = event.event_digest;
  });
}

export function registerRestorationAuthorityTest({
  sourceCohort,
  v2Cohort,
  centralRegistry,
  v2Registry,
  authorityDigest,
  REPOSITORY,
}: RestorationAuthorityHelpers) {
  test("restoration rereads protected main and keeps source and original target at one revision", async () => {
    const { cohort: origin } = await sourceCohort();
    const successor = v2Cohort(origin);
    successor.upgradeFrom = [origin.cohortId];
    successor.rollbackTo = [origin.cohortId];
    const old = centralRegistry(origin);
    const next = v2Registry(successor);
    const registry: Registry = {
      schema_version: 1,
      cohorts: [...old.cohorts, ...next.cohorts],
      events: [...old.events, ...next.events],
    };
    bindRestorationEvents(registry, authorityDigest);
    let revision = "8".repeat(40);
    const urls: string[] = [];
    let observedTime = Date.parse("2026-09-06T00:00:00Z"),
      clockReads = 0;
    const reader = new GitHubCohortAuthorityReader(
      async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify(String(url).endsWith("/commits/main") ? { sha: revision } : registry),
        );
      },
      () => {
        clockReads += 1;
        return observedTime;
      },
    );
    const options = { source: successor, origin, repository: REPOSITORY };
    const first = await reader.readRestoration(options);
    assert.equal(first.source.revision, revision);
    assert.equal(first.target.revision, revision);
    assert.equal(first.target.cohort.cohortId, origin.cohortId);
    revision = "9".repeat(40);
    const second = await reader.readRestoration(options);
    assert.equal(second.source.revision, revision);
    assert.equal(second.target.revision, revision);
    assert.equal(
      clockReads,
      2,
      "Each complete authority read observes one instant for both Cohorts",
    );
    assert.ok(urls[2].endsWith("/commits/main"));
    assert.ok(urls[3].includes(`/${revision}/governance/docs-qualified-cohorts.json`));
    registry.events[1].state = "SUPERSEDED";
    registry.events[1].support_until = "2020-01-01T00:00:00Z";
    bindRestorationEvents(registry, authorityDigest);
    await assert.rejects(reader.readRestoration(options), /support has expired/u);
    registry.events[1].support_until = "2099-01-01T00:00:00Z";
    bindRestorationEvents(registry, authorityDigest);
    assert.equal((await reader.readRestoration(options)).target.cohort.cohortId, origin.cohortId);
    const expires = Date.parse(registry.events[1].support_until);
    observedTime = expires - 1;
    assert.equal((await reader.readRestoration(options)).target.cohort.cohortId, origin.cohortId);
    observedTime = expires;
    await assert.rejects(reader.readRestoration(options), /support has expired/u);
    observedTime = NaN;
    await assert.rejects(reader.readRestoration(options), /support has expired/u);
    assert.ok(first.target.cohort.schemaVersion === 1);
    assert.ok(first.source.cohort.schemaVersion === 2);
    const proof = {
      sourceCohort: first.target.cohort,
      targetCohort: first.source.cohort,
      consumer: {
        root: "/TEST-only-authority",
        device: "1",
        inode: "1",
        birthtimeNs: "1",
        repository: REPOSITORY,
      },
    };
    const fixedAuthority = { readRestoration: async () => first };
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.[0-9]{3}Z$/u, "Z");
    for (const [futureOrigin, futureSuccessor] of [
      [true, true],
      [true, false],
      [false, true],
    ]) {
      const candidateOrigin = { ...origin, ...(futureOrigin ? { eligibleAfter: future } : {}) };
      const candidateSuccessor = {
        ...successor,
        ...(futureSuccessor ? { eligibleAfter: future } : {}),
      };
      const candidateOld = centralRegistry(candidateOrigin),
        candidateNext = v2Registry(candidateSuccessor);
      const candidate: Registry = {
        schema_version: 1,
        cohorts: [...candidateOld.cohorts, ...candidateNext.cohorts],
        events: [...candidateOld.events, ...candidateNext.events],
      };
      bindRestorationEvents(candidate, authorityDigest);
      const project = (
        cohort: QualifiedDocsCohortBindingV1 | QualifiedDocsCohortBindingV2,
        generation: 1 | 2,
      ) =>
        projectQualifiedCohortAuthority({
          cohortId: cohort.cohortId,
          generation,
          registry: candidate,
          repository: REPOSITORY,
          revision,
        });
      const original = project(candidateOrigin, 1).cohort,
        target = project(candidateSuccessor, 2).cohort;
      assert.ok(original.schemaVersion === 1);
      assert.ok(target.schemaVersion === 2);
      const currentReader = new GitHubCohortAuthorityReader(
        async (url) =>
          new Response(
            JSON.stringify(String(url).endsWith("/commits/main") ? { sha: revision } : candidate),
          ),
      );
      assert.ok(Date.parse(future) > Date.now());
      await assertRestorationAuthority(currentReader, {
        sourceCohort: original,
        targetCohort: target,
        consumer: {
          root: "/TEST-only-authority",
          device: "1",
          inode: "1",
          birthtimeNs: "1",
          repository: REPOSITORY,
        },
      });
    }
    for (const invalidTime of [NaN, Infinity, -Infinity]) {
      await assert.rejects(assertRestorationAuthority(fixedAuthority, proof, () => invalidTime));
    }
  });
}

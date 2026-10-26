import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promotePublicApiBaselines } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";
import { PUBLIC_API_COMPATIBILITY_RULES } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/rules.js";
import type { PublicApiRepository } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/public-api-repository.js";
import {
  assertNativeMigrationReview,
  assertNativeMigrationOrdinaryReport,
  prepareNativeMigrationPromotion,
  migrationBytes,
  migrationDigest,
  type NativeMigrationReview,
} from "../scripts/public-api-native-migration.ts";
import {
  nativeMigrationToolDifference,
  observeNativeMigration,
} from "../scripts/public-api-native-migration-observation.ts";

import {
  fixture,
  ordinaryReport,
  expectedCapabilities,
  withPromotionFixture,
  type Dependencies,
} from "./support/public-api-native-migration-fixture.ts";

void test("named content review binds the complete eight-package B/A packet", () => {
  const f = fixture();
  assert.doesNotThrow(() => {
    assertNativeMigrationReview(f.observation, f.review, f.policy);
  });
  assert.throws(() => {
    assertNativeMigrationReview(
      f.observation,
      { ...f.review, packages: f.review.packages.slice(1) },
      f.policy,
    );
  }, /eight-package/u);
  assert.throws(() => {
    assertNativeMigrationReview(
      f.observation,
      { ...f.review, toolDiffDigest: migrationDigest(Buffer.from("other")) },
      f.policy,
    );
  }, /entire tool difference/u);
  assert.throws(() => {
    assertNativeMigrationReview(
      f.observation,
      {
        ...f.review,
        packages: f.review.packages.map((p, i) =>
          i === 0 ? { ...p, baselinePath: "architecture/public-api/other.json" } : p,
        ),
      },
      f.policy,
    );
  }, /anchor/u);
  for (const key of [
    "baselineDigest",
    "archiveDigest",
    "configDigest",
    "releasedInputsDigest",
    "nativeReleasedDigest",
  ] as const) {
    assert.throws(() => {
      assertNativeMigrationReview(
        f.observation,
        {
          ...f.review,
          packages: f.review.packages.map((p, i) =>
            i === 0 ? { ...p, [key]: migrationDigest(Buffer.from("other")) } : p,
          ),
        },
        f.policy,
      );
    }, /reviewed|identity/u);
  }
  assert.throws(() => {
    assertNativeMigrationReview(
      f.observation,
      { ...f.review, verified: true } as NativeMigrationReview,
      f.policy,
    );
  }, /unknown/u);
});

void test("historical tool migration cannot discard exports, identities or parents", () => {
  const f = fixture();
  const row = f.observation.packages[0]!;
  assert.throws(
    () =>
      nativeMigrationToolDifference([
        { ...row, nativeReleased: { ...row.nativeReleased, entrypoints: [] } },
      ]),
    /coverage/u,
  );
  assert.throws(
    () =>
      nativeMigrationToolDifference([
        {
          ...row,
          nativeReleased: { ...row.nativeReleased, entrypoints: [{ exportPath: ".", items: [] }] },
        },
      ]),
    /identity/u,
  );
  const item = row.nativeReleased.entrypoints[0]!.items[0]!;
  assert.throws(
    () =>
      nativeMigrationToolDifference([
        {
          ...row,
          nativeReleased: {
            ...row.nativeReleased,
            entrypoints: [{ exportPath: ".", items: [{ ...item, parentKind: "Namespace" }] }],
          },
        },
      ]),
    /parent/u,
  );
});

void test("ordinary mismatch remains an exact retained negative alongside native comparison", async () => {
  const f = fixture();
  const report = await ordinaryReport(f);
  const args = { ...f, report, exitCode: 1, expectedCapabilities };
  await assertNativeMigrationOrdinaryReport(args);
  assert.equal(report.outcome, "violations");
  assert.equal(report.summary.errors, 8);
  assert.equal(
    report.capabilities[1]!.diagnostics[0]!.ruleId,
    PUBLIC_API_COMPATIBILITY_RULES.baselineToolMismatch.id,
  );
  await assert.rejects(
    assertNativeMigrationOrdinaryReport({ ...args, exitCode: 0 }),
    /ordinary full report/u,
  );
  await assert.rejects(
    assertNativeMigrationOrdinaryReport({ ...args, report: { ...report, coverage: "selected" } }),
    /ordinary full report/u,
  );
  await assert.rejects(
    assertNativeMigrationOrdinaryReport({
      ...args,
      expectedCapabilities: expectedCapabilities.slice(1),
    }),
    /inventory/u,
  );
  const wrong = structuredClone(report);
  const diagnostic = wrong.capabilities[1]!.diagnostics[0]!;
  await assert.rejects(
    assertNativeMigrationOrdinaryReport({
      ...args,
      report: {
        ...wrong,
        capabilities: [
          wrong.capabilities[0]!,
          {
            ...wrong.capabilities[1]!,
            diagnostics: [
              { ...diagnostic, location: { path: "wrong.json" } },
              ...wrong.capabilities[1]!.diagnostics.slice(1),
            ],
          },
        ],
      },
    }),
    /shapes/u,
  );
  await assert.rejects(
    assertNativeMigrationOrdinaryReport({
      ...args,
      observation: { ...f.observation, artifactDiagnostics: [diagnostic] },
    }),
    /native candidate/u,
  );
});

void test("ordinary promotion still rejects tool mismatch even for identical signatures", async () =>
  withPromotionFixture(async (f) => {
    await assert.rejects(
      promotePublicApiBaselines({ consumerRoot: f.root, policy: f.policy }, f.typed),
      /API Extractor changed/u,
    );
    assert.equal(f.writes.length, 0);
  }));

void test("version plan migrates every same-version unchanged typed B using actual B preimages", async () =>
  withPromotionFixture(async (f) => {
    const plan = await prepareNativeMigrationPromotion(
      { consumerRoot: f.root, ...f },
      { typed: f.typed, artifacts: f.artifacts },
    );
    assert.equal(plan.writes.length, 8);
    assert.equal(f.writes.length, 0);
    for (const write of plan.writes) {
      assert.equal(
        write.preimageDigest,
        f.review.packages.find((x) => x.baselinePath === write.destination)!.baselineDigest,
      );
    }
    await plan.apply();
    assert.equal(f.writes.length, 8);
    await plan.apply();
    assert.equal(f.writes.length, 8);
  }));

void test("partial version application replays exact postimages and finishes remaining B files", async () =>
  withPromotionFixture(async (f) => {
    const plan = await prepareNativeMigrationPromotion(
      { consumerRoot: f.root, ...f },
      { typed: f.typed, artifacts: f.artifacts },
    );
    f.failNext.packageName = f.policy.packages[3]!.packageName;
    await assert.rejects(plan.apply(), /interruption/u);
    assert.equal(f.writes.length, 3);
    const replay = await prepareNativeMigrationPromotion(
      { consumerRoot: f.root, ...f },
      { typed: f.typed, artifacts: f.artifacts },
    );
    assert.equal(replay.writes.length, 5);
    await replay.apply();
    assert.equal(f.writes.length, 8);
    assert.equal(new Set(f.writes).size, 8);
  }));

void test("all physical destinations preflight before the first application write", async () =>
  withPromotionFixture(async (f) => {
    const plan = await prepareNativeMigrationPromotion(
      { consumerRoot: f.root, ...f },
      { typed: f.typed, artifacts: f.artifacts },
    );
    await writeFile(join(f.root, f.policy.packages.at(-1)!.releasedBaselinePath), "changed");
    await assert.rejects(plan.apply(), /preimage changed/u);
    assert.equal(f.writes.length, 0);
  }));

void test("application preflight keeps the originally captured consumer root", async () =>
  withPromotionFixture(async (f) => {
    const options = { consumerRoot: f.root, ...f };
    const plan = await prepareNativeMigrationPromotion(options, {
      typed: f.typed,
      artifacts: f.artifacts,
    });
    const decoy = await mkdtemp(join(tmpdir(), "native-api-migration-decoy-"));
    try {
      for (const p of f.policy.packages) {
        await mkdir(dirname(join(decoy, p.releasedBaselinePath)), { recursive: true });
        await writeFile(
          join(decoy, p.releasedBaselinePath),
          migrationBytes(
            f.observation.packages.find((row) => row.packageName === p.packageName)!.baseline,
          ),
        );
      }
      await writeFile(join(f.root, f.policy.packages.at(-1)!.releasedBaselinePath), "changed");
      options.consumerRoot = decoy;
      await assert.rejects(plan.apply(), /preimage changed/u);
      assert.equal(f.writes.length, 0);
    } finally {
      await rm(decoy, { recursive: true, force: true });
    }
  }));

void test("reviewed observations cannot change during an awaited physical baseline read", async () =>
  withPromotionFixture(async (f) => {
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let first = true;
    const repository: PublicApiRepository = {
      ...f.typed.repository,
      readReleasedBaseline: async (root, p, signal) => {
        const baseline = await f.typed.repository.readReleasedBaseline(root, p, signal);
        if (first) {
          first = false;
          reached.resolve();
          await resume.promise;
        }
        return baseline;
      },
    };
    const typed = { ...f.typed, repository };
    const preparation = prepareNativeMigrationPromotion(
      { consumerRoot: f.root, ...f },
      { typed, artifacts: f.artifacts },
    );
    await reached.promise;
    const row = f.observation.packages.at(-1)!;
    const entrypoints = [
      {
        exportPath: ".",
        items: [
          {
            ...row.nativeCandidate.entrypoints[0]!.items[0]!,
            signature: "export type Value = number;",
          },
        ],
      },
    ];
    Object.assign(row.nativeReleased, { entrypoints });
    Object.assign(row.nativeCandidate, { entrypoints });
    resume.resolve();
    await assert.rejects(preparation, /candidate changed since/u);
    assert.equal(f.writes.length, 0);
  }));

void test("an initially complete postimage cannot revert while remaining baselines apply", async () =>
  withPromotionFixture(async (f) => {
    const p = f.policy.packages[0]!;
    const row = f.observation.packages[0]!;
    await writeFile(join(f.root, p.releasedBaselinePath), migrationBytes(row.nativeCandidate));
    const plan = await prepareNativeMigrationPromotion(
      { consumerRoot: f.root, ...f },
      { typed: f.typed, artifacts: f.artifacts },
    );
    assert.equal(plan.writes.length, 7);
    await writeFile(join(f.root, p.releasedBaselinePath), migrationBytes(row.baseline));
    await assert.rejects(plan.apply(), /preimage changed/u);
    assert.equal(f.writes.length, 0);
  }));

void test("same-version candidate drift and an unapproved real break remain rejected", async () =>
  withPromotionFixture(async (f) => {
    const row = f.observation.packages.at(-1)!;
    const changed = {
      ...row.nativeCandidate,
      entrypoints: [
        {
          exportPath: ".",
          items: [
            {
              ...row.nativeCandidate.entrypoints[0]!.items[0]!,
              signature: "export type Value = number;",
            },
          ],
        },
      ],
    };
    const changedObservation = {
      ...f.observation,
      packages: f.observation.packages.map((x) =>
        x === row ? { ...x, nativeCandidate: changed } : x,
      ),
    };
    const typed = {
      ...f.typed,
      extractor: {
        extract: async (_root: string, p: { packageName: string }) =>
          changedObservation.packages.find((x) => x.packageName === p.packageName)!.nativeCandidate,
      },
    };
    await assert.rejects(
      prepareNativeMigrationPromotion(
        { consumerRoot: f.root, ...f, observation: changedObservation },
        { typed, artifacts: f.artifacts },
      ),
      /changed after baseline/u,
    );
    const released = { ...changed, packageVersion: "2.0.0" };
    const breakingObservation = {
      ...changedObservation,
      packages: changedObservation.packages.map((x) =>
        x.packageName === row.packageName ? { ...x, nativeCandidate: released } : x,
      ),
    };
    const breaking = {
      ...typed,
      repository: {
        ...typed.repository,
        readReleaseEvidence: async (_root: string, _path: string, p: { packageName: string }) => ({
          packageName: p.packageName,
          packageVersion: p.packageName === row.packageName ? "2.0.0" : "1.0.0",
        }),
      },
      extractor: {
        extract: async (_root: string, p: { packageName: string }) =>
          breakingObservation.packages.find((x) => x.packageName === p.packageName)!
            .nativeCandidate,
      },
    };
    await assert.rejects(
      prepareNativeMigrationPromotion(
        { consumerRoot: f.root, ...f, observation: breakingObservation },
        { typed: breaking, artifacts: f.artifacts },
      ),
      /not approved/u,
    );
    assert.equal(f.writes.length, 0);
  }));

void test("last-package artifact refusal leaves all typed baselines unchanged", async () =>
  withPromotionFixture(async (f) => {
    const artifacts = {
      ...f.artifacts,
      extractor: {
        extract: async (...args: Parameters<Dependencies["extractor"]["extract"]>) => {
          if (args[1].packageName === f.policy.packages.at(-1)!.packageName) {
            throw new Error("artifact refusal");
          }
          return f.artifacts.extractor.extract(...args);
        },
      },
    };
    await assert.rejects(
      prepareNativeMigrationPromotion(
        { consumerRoot: f.root, ...f },
        { typed: f.typed, artifacts },
      ),
      /artifact refusal/u,
    );
    assert.equal(f.writes.length, 0);
  }));

void test("a reviewed plan keeps its captured postimages when caller objects subsequently change", async () =>
  withPromotionFixture(async (f) => {
    const expected = migrationBytes(f.observation.packages[0]!.nativeCandidate);
    const plan = await prepareNativeMigrationPromotion(
      { consumerRoot: f.root, ...f },
      { typed: f.typed, artifacts: f.artifacts },
    );
    Object.assign(f.observation.packages[0]!.nativeCandidate, { entrypoints: [] });
    await plan.apply();
    assert.deepEqual(
      await readFile(join(f.root, f.policy.packages[0]!.releasedBaselinePath)),
      expected,
    );
  }));

void test("candidate root cannot masquerade as historical archive data", async () => {
  const f = fixture();
  await assert.rejects(
    observeNativeMigration({
      consumerRoot: "/tmp/same-candidate",
      releasedRoot: "/tmp/same-candidate",
      policy: f.policy,
      packages: f.policy.packages.map((p) => ({
        packageName: p.packageName,
        baselineBytes: new Uint8Array(),
        archiveBytes: new Uint8Array(),
        configBytes: new Uint8Array(),
      })),
    }),
    /candidate cannot/u,
  );
});

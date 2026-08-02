import assert from "node:assert/strict";
import {
  assert as assertProperty,
  integer,
  property,
  uniqueArray,
} from "fast-check";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
);
const propertyTesting = await import(pathToFileURL(join(distRoot, "index.js")).href);

function seedBank() {
  return {
    schemaVersion: 1,
    propertyId: "runtime-operation.idempotency",
    numRuns: 250,
    seeds: [42, -3, 17],
  };
}

test("normalizes a deterministic seed bank and produces fast-check-compatible replay parameters", () => {
  const bank = propertyTesting.normalizeDeterministicSeedBank(seedBank());
  assert.deepEqual(bank.seeds, [-3, 17, 42]);
  assert.deepEqual(propertyTesting.createFastCheckParameters(bank, 17), {
    seed: 17,
    numRuns: 250,
  });
  assert.deepEqual(
    propertyTesting.createFastCheckParameters(bank, 17, {
      schemaVersion: 1,
      propertyId: "runtime-operation.idempotency",
      seed: 17,
      numRuns: 250,
      path: "4:2:0",
      counterexampleDigest: `sha256:${"a".repeat(64)}`,
    }),
    { seed: 17, numRuns: 250, path: "4:2:0" },
  );
});

test("rejects duplicate seeds, unsafe replay paths, and detached replay evidence", () => {
  assert.throws(
    () => propertyTesting.normalizeDeterministicSeedBank({ ...seedBank(), seeds: [1, 1] }),
    (error) => {
      assert.match(error.message, /duplicate seeds/u);
      assert.equal(error.name, "PropertyTestingEvidenceError");
      assert.equal(
        error instanceof propertyTesting.PropertyTestingEvidenceError,
        true,
      );
      assert.equal(error.code, "PROPERTY_TESTING_EVIDENCE_INVALID");
      return true;
    },
  );
  assert.throws(
    () =>
      propertyTesting.normalizePropertyReplayEvidence({
        schemaVersion: 1,
        propertyId: "runtime-operation.idempotency",
        seed: 17,
        numRuns: 250,
        path: "0:1\nmalicious",
      }),
    /unsupported characters/u,
  );
  assert.throws(
    () =>
      propertyTesting.createFastCheckParameters(seedBank(), 17, {
        schemaVersion: 1,
        propertyId: "other-property",
        seed: 17,
        numRuns: 250,
      }),
    /must bind to the same property/u,
  );
});

test("replays normalization properties with the declared deterministic seed bank", () => {
  const bank = propertyTesting.normalizeDeterministicSeedBank(seedBank());
  for (const seed of bank.seeds) {
    assertProperty(
      property(
        uniqueArray(integer({ min: -2_147_483_648, max: 2_147_483_647 }), {
          minLength: 1,
          maxLength: 64,
        }),
        (seeds) => {
          const normalized = propertyTesting.normalizeDeterministicSeedBank({
            schemaVersion: 1,
            propertyId: bank.propertyId,
            numRuns: bank.numRuns,
            seeds,
          });
          assert.deepEqual(normalized.seeds, seeds.toSorted((left, right) => left - right));
          assert.deepEqual(
            propertyTesting.normalizeDeterministicSeedBank(normalized),
            normalized,
          );
        },
      ),
      propertyTesting.createFastCheckParameters(bank, seed),
    );
  }
});

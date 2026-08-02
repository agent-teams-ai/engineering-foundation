import assert from "node:assert/strict";
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
const propertyTesting = await import(
  pathToFileURL(
    join(
      distRoot,
      "capabilities",
      "property-testing-standard",
      "test-support",
      "deterministic-seed-bank.js",
    ),
  ).href,
);

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
    /duplicate seeds/u,
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

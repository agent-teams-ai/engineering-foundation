import assert from "node:assert/strict";
import test from "node:test";

import {
  testRoots,
  testRootsForPackages,
  validateTestManifestData,
  validateTestManifests,
} from "../scripts/check-test-manifests.mjs";
import { builtTestArguments } from "../scripts/run-built-tests.mjs";

const examplePackages = Object.freeze([
  Object.freeze({ root: "packages/example" }),
]);

function fixture(packages = examplePackages) {
  return {
    packages,
    shardManifest: {
      schemaVersion: 1,
      source: {
        runId: 1,
        headSha: "a".repeat(40),
        strategy: "fixture",
      },
      shards: [
        { id: "1", tests: ["tests/a.test.mjs"] },
        { id: "2", tests: ["tests/b.test.mjs"] },
        { id: "3", tests: ["tests/c.test.mjs"] },
        { id: "4", tests: ["tests/d.test.mjs"] },
      ],
    },
    coverageManifest: {
      schemaVersion: 3,
      tool: { name: "c8", version: "12.0.0" },
      processBootstrap: "scripts/coverage-process-bootstrap.mjs",
      include: ["packages/example/dist/**/*.js"],
      exclude: ["packages/example/dist/**/*.d.ts"],
      additionalTestsByShard: { 1: [], 2: [], 3: [], 4: [] },
      legacyTests: ["tests/a.test.mjs"],
      thresholds: { branches: 1, functions: 1, lines: 1 },
      evidenceThresholds: { branches: 1, functions: 1, lines: 1 },
    },
    testPaths: [
      "tests/a.test.mjs",
      "tests/b.test.mjs",
      "tests/c.test.mjs",
      "tests/d.test.mjs",
    ],
  };
}

test("repository test manifests cover every top-level test exactly once", async () => {
  const result = await validateTestManifests();
  assert.equal(result.tests.length, result.testCount);
  assert.ok(result.tests.includes("packages/docs-protocol-agent-teams/tests/qualification.test.mjs"));
  assert.ok(testRoots.includes("packages/docs-protocol-agent-teams/tests"));
  assert.deepEqual([...result.shards.keys()], ["1", "2", "3", "4"]);
  assert.equal([...result.coverageShards.values()].flat().length, result.testCount);
  assert.ok(result.coverageConfig.include.includes(
    "packages/docs-protocol-agent-teams/dist/**/*.js",
  ));
});

test("built test runner consumes the validated inventory without shell globs", () => {
  assert.deepEqual(builtTestArguments({ tests: [
    "tests/a.test.mjs",
    "packages/example/tests/b.test.mjs",
  ] }), [
    "--test",
    "--test-concurrency=1",
    "tests/a.test.mjs",
    "packages/example/tests/b.test.mjs",
  ]);
  assert.throws(() => builtTestArguments({ tests: [] }), /non-empty validated test inventory/u);
});

test("test manifests fail closed for missing, duplicate, and nonexistent coverage tests", () => {
  const missing = fixture();
  missing.shardManifest.shards[0].tests = [];
  assert.throws(() => validateTestManifestData(missing), /must contain tests/u);

  const duplicate = fixture();
  duplicate.shardManifest.shards[1].tests = ["tests/a.test.mjs"];
  assert.throws(() => validateTestManifestData(duplicate), /assigned more than once/u);

  const duplicateCoverageAddition = fixture();
  duplicateCoverageAddition.coverageManifest.additionalTestsByShard["2"] = [
    "tests/a.test.mjs",
  ];
  assert.throws(
    () => validateTestManifestData(duplicateCoverageAddition),
    /assigned more than once/u,
  );

  const nonexistentCoverage = fixture();
  nonexistentCoverage.coverageManifest.legacyTests = ["tests/missing.test.mjs"];
  assert.throws(() => validateTestManifestData(nonexistentCoverage), /does not exist/u);
});

test("coverage manifest pins its merger and bounded thresholds", () => {
  const floatingTool = fixture();
  floatingTool.coverageManifest.tool.version = "latest";
  assert.throws(() => validateTestManifestData(floatingTool), /exact c8 version/u);

  for (const invalidThreshold of [0, 101, 36.5]) {
    const data = fixture();
    data.coverageManifest.evidenceThresholds.lines = invalidThreshold;
    assert.throws(() => validateTestManifestData(data), /integer from 1 through 100/u);
  }
});

test("coverage arrays are exact projections of publishable package roots", () => {
  const missing = fixture([
    ...examplePackages,
    { root: "packages/missing-example" },
  ]);
  assert.throws(
    () => validateTestManifestData(missing),
    /missing=\[packages\/missing-example\/dist\/\*\*\/\*\.js\]/u,
  );

  for (const unexpected of [
    "packages/stale/dist/**/*.js",
    "outside/dist/**/*.js",
    "packages/**/dist/**/*.js",
  ]) {
    const data = fixture();
    data.coverageManifest.include = [unexpected];
    assert.throws(
      () => validateTestManifestData(data),
      /must exactly project publishable package roots.*missing=.*packages\/example.*unexpected=/u,
    );
  }

  const duplicate = fixture();
  duplicate.coverageManifest.include.push(duplicate.coverageManifest.include[0]);
  assert.throws(
    () => validateTestManifestData(duplicate),
    /coverage include contains a duplicate/u,
  );

  const reordered = fixture([
    { root: "packages/example" },
    { root: "packages/first-example" },
  ]);
  reordered.coverageManifest.include.unshift("packages/first-example/dist/**/*.js");
  reordered.coverageManifest.exclude.unshift("packages/first-example/dist/**/*.d.ts");
  assert.throws(
    () => validateTestManifestData(reordered),
    /coverage include must exactly project.*order differs/u,
  );
});

test("coverage projections change when injected package membership changes", () => {
  const packages = [
    ...examplePackages,
    { root: "packages/fifth-example" },
  ];
  const staleProjection = fixture(packages);
  assert.throws(
    () => validateTestManifestData(staleProjection),
    /missing=\[packages\/fifth-example\/dist\/\*\*\/\*\.js\]/u,
  );

  const completeProjection = fixture(packages);
  completeProjection.coverageManifest.include.push(
    "packages/fifth-example/dist/**/*.js",
  );
  completeProjection.coverageManifest.exclude.push(
    "packages/fifth-example/dist/**/*.d.ts",
  );
  assert.doesNotThrow(() => validateTestManifestData(completeProjection));
});

test("test manifests reject non-portable and traversal paths", () => {
  for (const hostilePath of [
    "../tests/a.test.mjs",
    "/tests/a.test.mjs",
    "tests\\a.test.mjs",
    "tests/nested/a.test.mjs",
  ]) {
    const data = fixture();
    data.shardManifest.shards[0].tests = [hostilePath];
    assert.throws(() => validateTestManifestData(data), /portable top-level/u);
  }
});

test("package test root discovery rejects traversal", () => {
  assert.throws(
    () => testRootsForPackages([{ root: "packages/../outside" }]),
    /not bounded and portable/u,
  );
});

test("test manifests reject Windows-reserved filenames", () => {
  for (const reservedName of ["aux", "con", "nul", "prn", "com1", "com9", "lpt1", "lpt9"]) {
    const data = fixture();
    data.shardManifest.shards[0].tests = [`tests/${reservedName}.test.mjs`];
    assert.throws(() => validateTestManifestData(data), /Windows-reserved/u);
  }
});

test("test manifests reject numeric shard ids", () => {
  const data = fixture();
  data.shardManifest.shards = data.shardManifest.shards.map((shard) => ({
    ...shard,
    id: Number(shard.id),
  }));
  assert.throws(() => validateTestManifestData(data), /id must be a string/u);
});

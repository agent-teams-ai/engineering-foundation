import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  testRoots,
  testRootsForPackages,
  repositoryRoot,
  validateMandatoryShardSelection,
  validateTestManifestData,
  validateTestManifests,
} from "../scripts/check-test-manifests.mjs";
import { builtTestArguments } from "../scripts/run-built-tests.mjs";
import * as manifestTools from "../scripts/check-test-manifests.mjs";
import { selectTestShardPaths } from "../scripts/run-test-shard.mjs";

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
        { id: "5", tests: ["tests/e.test.mjs"] },
        { id: "6", tests: ["tests/f.test.mjs"] },
        { id: "7", tests: ["tests/g.test.mjs"] },
        { id: "8", tests: ["tests/h.test.mjs"] },
      ],
    },
    coverageManifest: {
      schemaVersion: 3,
      tool: { name: "c8", version: "12.0.0" },
      processBootstrap: "scripts/coverage-process-bootstrap.mjs",
      include: ["packages/example/dist/**/*.js"],
      exclude: ["packages/example/dist/**/*.d.ts"],
      additionalTestsByShard: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [] },
      legacyTests: ["tests/a.test.mjs"],
      thresholds: { branches: 1, functions: 1, lines: 1 },
      evidenceThresholds: { branches: 1, functions: 1, lines: 1 },
    },
    testPaths: [
      "tests/a.test.mjs",
      "tests/b.test.mjs",
      "tests/c.test.mjs",
      "tests/d.test.mjs",
      "tests/e.test.mjs",
      "tests/f.test.mjs",
      "tests/g.test.mjs",
      "tests/h.test.mjs",
    ],
  };
}

test("repository test manifests cover every top-level test exactly once", async () => {
  const result = await validateTestManifests();
  assert.equal(result.tests.length, result.testCount);
  assert.ok(result.tests.includes("packages/docs-protocol-agent-teams/tests/qualification.test.mjs"));
  assert.ok(testRoots.includes("packages/docs-protocol-agent-teams/tests"));
  assert.deepEqual([...result.shards.keys()], ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal([...result.coverageShards.values()].flat().length, result.testCount);
  assert.ok(result.coverageConfig.include.includes(
    "packages/docs-protocol-agent-teams/dist/**/*.js",
  ));
});

test("Foundation mandatory identities belong to their required shard", async () => {
  const contract = JSON.parse(await readFile(join(repositoryRoot,
    "architecture/foundation/node-test-execution.json"), "utf8"));
  const manifest = await validateTestManifests();
  assert.doesNotThrow(() => validateMandatoryShardSelection(contract, manifest));
  for (const file of new Set(contract.required.map((item) => item.file))) {
    const coverageOnly = {
      ...manifest,
      shards: new Map([...manifest.shards].map(([id, files]) =>
        [id, files.filter((path) => path !== file)])),
    };
    assert.throws(() => validateMandatoryShardSelection(contract, coverageOnly),
      /not selected by a required shard/u, `${file} cannot rely only on coverage selection`);
  }
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

test("feature tests retain closed manifest coverage and a bounded portable path", () => {
  const input = fixture();
  const path = "tests/features/quality-coverage/policy.test.mjs";
  input.testPaths.push(path);
  input.shardManifest.shards[0].tests.push(path);
  assert.equal(validateTestManifestData(input).testCount, 9);
  for (const invalid of ["tests/features/con/policy.test.mjs", "tests/features/quality/deep/policy.test.mjs", "tests/arbitrary/policy.test.mjs"]) {
    const bad = structuredClone(input);
    bad.testPaths[8] = invalid;
    bad.shardManifest.shards[0].tests[1] = invalid;
    assert.throws(() => validateTestManifestData(bad), /portable top-level test path/u);
  }
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


test("managed platform routing preserves complete Linux qualification and every portable identity", async () => {
  const manifest = await validateTestManifests();
  const linuxOnly = [
    "packages/docs-protocol-agent-teams/tests/managed-runtime-attempt-close.test.mjs",
    "packages/docs-protocol-agent-teams/tests/managed-runtime-attempt.test.mjs",
    "packages/docs-protocol-agent-teams/tests/managed-runtime-corrective.test.mts",
    "packages/docs-protocol-agent-teams/tests/managed-runtime-custody.test.mts",
    "packages/docs-protocol-agent-teams/tests/managed-runtime-observation.test.mjs",
    "packages/docs-protocol-agent-teams/tests/managed-runtime-parent-environment.test.mts",
    "packages/docs-protocol-agent-teams/tests/managed-runtime-pnpm-enforcement.test.mjs",
    "packages/docs-protocol-agent-teams/tests/managed-runtime-process.test.mjs",
  ];
  const ids = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const globalInventory = [...manifest.tests];
  const requiredShardFiles = [...manifest.shards.values()].flat();
  assert.equal(manifest.testCount, globalInventory.length);
  assert.deepEqual(selectTestShardPaths(manifest, ids, true, "linux", "x64").toSorted(), globalInventory.toSorted());
  assert.deepEqual(selectTestShardPaths(manifest, ids, false, "linux", "x64"), requiredShardFiles);
  // Linux on another architecture is outside the linux/x64 runtime support contract.
  for (const [platform, architecture] of [["win32", "x64"], ["darwin", "arm64"], ["linux", "arm64"]]) {
    const selected = selectTestShardPaths(manifest, ids, false, platform, architecture);
    assert.deepEqual(selected, requiredShardFiles.filter((path) => !linuxOnly.includes(path)));
    assert.equal(selected.length, requiredShardFiles.length - 8);
    assert.ok(selected.includes("packages/docs-protocol-agent-teams/tests/managed-portable-profile.test.mjs"));
    assert.throws(() => selectTestShardPaths(manifest, ids, true, platform, architecture), /complete Linux selection/u);
    const built = manifestTools.selectTestPathsForPlatform(manifest, manifest.tests, platform, architecture);
    assert.deepEqual(built, globalInventory.filter((path) => !linuxOnly.includes(path)));
    assert.equal(built.length, globalInventory.length - linuxOnly.length);
    const contract = JSON.parse(await readFile(join(repositoryRoot,
      "architecture/foundation/node-test-execution.json"), "utf8"));
    for (const identity of contract.required) {
      assert.ok(selected.includes(identity.file), JSON.stringify(identity));
    }
  }
  assert.deepEqual(manifest.tests, globalInventory);
});

test("managed platform policy rejects inventory drift, empty dispatch and mandatory authority loss", async () => {
  const manifest = await validateTestManifests();
  const linuxFile = "packages/docs-protocol-agent-teams/tests/managed-runtime-observation.test.mjs";
  for (const tests of [
    manifest.tests.filter((path) => path !== linuxFile),
    [...manifest.tests, "packages/docs-protocol-agent-teams/tests/managed-runtime-extra.test.mjs"],
    manifest.tests.map((path) => path === linuxFile ? `${path}.renamed` : path),
  ]) {
    assert.throws(() => manifestTools.validateManagedTestPlatforms({ ...manifest, tests }), /platform policy review/u);
  }
  for (const [files, platform, message] of [
    [[linuxFile], "win32", /empty qualification/u],
    [[linuxFile, linuxFile], "linux", /unique inventoried/u],
    [["tests/uninventoried.test.mjs"], "linux", /unique inventoried/u],
    [[linuxFile], "freebsd", /unsupported test platform/u],
  ]) {
    assert.throws(() => manifestTools.selectTestPathsForPlatform(manifest, files, platform), message);
  }
  assert.throws(() => manifestTools.selectTestPathsForPlatform(manifest, [linuxFile], "linux", "arm64"),
    /empty qualification/u);
  const contract = JSON.parse(await readFile(join(repositoryRoot,
    "architecture/foundation/node-test-execution.json"), "utf8"));
  contract.required.push({ file: linuxFile, names: ["new mandatory runtime identity"], kind: "test" });
  assert.throws(() => validateMandatoryShardSelection(contract, manifest), /reviewed platform contract/u);
});

test("repository shard placement rejects loss of loader isolation or managed runtime tooling", async () => {
  const manifest = await validateTestManifests();
  for (const [source, file, expected] of [
    ["3", "tests/source-dependency-loader-cli.test.mjs", /pinned loader/u],
    ["4", "packages/docs-protocol-agent-teams/tests/managed-runtime-observation.test.mjs", /Node 26 tooling/u],
    ["4", "packages/docs-protocol-agent-teams/tests/managed-runtime-process.test.mjs", /Node 26 tooling/u],
  ]) {
    const shards = new Map([...manifest.shards].map(([id, files]) => [id, [...files]]));
    shards.set(source, shards.get(source).filter((path) => path !== file));
    shards.get("1").push(file);
    assert.throws(() => manifestTools.validateRepositoryShardPins({ ...manifest, shards }), expected);
  }
});

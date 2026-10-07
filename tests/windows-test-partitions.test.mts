import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateTestManifests } from "../scripts/check-test-manifests.mjs";
import { parseTestShardArguments, selectTestShardPaths } from "../scripts/run-test-shard.mjs";
import {
  selectWindowsTestLanePaths,
  WINDOWS_TEST_LANES,
  type WindowsTestManifest,
} from "../scripts/windows-test-partitions.mts";

const lanes = ["a", "b", "c", "d", "e"] as const;
const loader = "tests/source-dependency-loader-cli.test.mjs";
const linuxOnly = [
  "packages/docs-protocol-agent-teams/tests/managed-runtime-observation.test.mjs",
  "packages/docs-protocol-agent-teams/tests/managed-runtime-process.test.mjs",
  "packages/docs-protocol-agent-teams/tests/managed-runtime-attempt-close.test.mjs",
  "packages/docs-protocol-agent-teams/tests/managed-runtime-attempt.test.mjs",
  "packages/docs-protocol-agent-teams/tests/managed-runtime-corrective.test.mts",
  "packages/docs-protocol-agent-teams/tests/managed-runtime-custody.test.mts",
  "packages/docs-protocol-agent-teams/tests/managed-runtime-parent-environment.test.mts",
  "packages/docs-protocol-agent-teams/tests/managed-runtime-pnpm-enforcement.test.mjs",
];

function inventoriedPaths(value: unknown): readonly string[] {
  assert.ok(Array.isArray(value));
  return value.map((file: unknown) => {
    assert.ok(typeof file === "string");
    return file;
  });
}

function inventoriedShards(value: ReadonlyMap<unknown, unknown>): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const [id, files] of value) {
    assert.ok(typeof id === "string");
    result.set(id, inventoriedPaths(files));
  }
  return result;
}

async function repositoryManifest(): Promise<WindowsTestManifest> {
  const manifest = await validateTestManifests();
  const additionalTestsByShard: Record<string, readonly string[]> = {};
  for (const [id, files] of Object.entries(manifest.coverageConfig.additionalTestsByShard)) {
    additionalTestsByShard[id] = inventoriedPaths(files);
  }
  return {
    tests: inventoriedPaths(manifest.tests),
    testCount: manifest.testCount,
    shards: inventoriedShards(manifest.shards),
    coverageShards: inventoriedShards(manifest.coverageShards),
    coverageConfig: { additionalTestsByShard },
  };
}

function fixture() {
  const shards = new Map<string, string[]>([
    ["1", ["tests/a.test.mjs"]],
    ["2", ["tests/b.test.mjs"]],
    ["3", [loader, "tests/remainder.test.mjs"]],
    ["4", ["tests/d.test.mjs", ...linuxOnly]],
    ["5", ["tests/e.test.mjs"]],
    ["6", ["tests/f.test.mjs"]],
    ["7", ["tests/g.test.mjs"]],
    ["8", ["tests/h.test.mjs"]],
  ]);
  const additionalTestsByShard: Record<string, string[]> = {
    "1": [], "2": ["tests/coverage-only.test.mjs"], "3": [], "4": [],
    "5": [], "6": [], "7": [], "8": [],
  };
  const coverageShards = new Map<string, string[]>();
  for (const [id, files] of shards) {
    coverageShards.set(id, [...files, ...additionalTestsByShard[id]!]);
  }
  const tests = [...coverageShards.values()].flat();
  return { tests, testCount: tests.length, shards, coverageShards,
    coverageConfig: { additionalTestsByShard } };
}

function fixturePolicy() {
  return {
    schemaVersion: 1,
    source: { runId: 1, headSha: "a".repeat(40), strategy: "Runtime configuration fixture" },
    lanes: {
      a: ["tests/a.test.mjs", "tests/e.test.mjs"],
      b: ["tests/b.test.mjs", "tests/f.test.mjs"],
      c: [loader],
      d: ["tests/d.test.mjs", "tests/g.test.mjs"],
      e: ["tests/remainder.test.mjs", "tests/h.test.mjs"],
    },
  };
}

function selectFixtureLanePaths(manifest: WindowsTestManifest, lane: string,
  coverageEvidenceEnabled = false, platform: NodeJS.Platform = "win32",
  architecture: typeof process.arch = "x64", policy: unknown = fixturePolicy()): readonly string[] {
  return selectWindowsTestLanePaths(manifest, lane, coverageEvidenceEnabled, { platform, architecture, policy });
}

test("five fixed Windows lanes retain exact real canonical inventory and mandatory files", async () => {
  const manifest = await repositoryManifest();
  const before = structuredClone(manifest);
  const ids = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const canonical = [...manifest.shards.values()].flat();
  const admitted = canonical.filter((file) => !linuxOnly.includes(file));
  const byLane = new Map<string, readonly string[]>();
  assert.deepEqual(WINDOWS_TEST_LANES, lanes);
  for (const lane of lanes) {
    byLane.set(lane, selectWindowsTestLanePaths(manifest, lane, false, { platform: "win32", architecture: "x64" }));
  }
  const selected = [...byLane.values()].flat();
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.toSorted(), admitted.toSorted());
  assert.deepEqual(byLane.get("c"), [loader]);
  for (const files of byLane.values()) {
    assert.ok(files.length > 0);
    const originalPositions = files.map((file) => canonical.indexOf(file));
    assert.deepEqual(originalPositions, originalPositions.toSorted((left, right) => left - right));
  }
  assert.deepEqual(selectTestShardPaths(manifest, ids, false, "linux", "x64"), canonical);
  assert.deepEqual(selectTestShardPaths(manifest, ids, true, "linux", "x64").toSorted(),
    manifest.tests.toSorted());
  const contract: { required: readonly { file: string }[] } = JSON.parse(await readFile(
    new URL("../architecture/foundation/node-test-execution.json", import.meta.url), "utf8"));
  for (const { file } of contract.required) {
    assert.equal(selected.filter((path) => path === file).length, 1, file);
  }
  assert.deepEqual(manifest, before);
});

test("new canonical files fail closed until explicitly assigned to the Windows policy", () => {
  for (const id of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
    const manifest = fixture();
    const added = `tests/future-shard-${id}.test.mts`;
    manifest.shards.get(id)!.push(added);
    manifest.coverageShards.set(id, [...manifest.shards.get(id)!,
      ...manifest.coverageConfig.additionalTestsByShard[id]!]);
    manifest.tests.push(added);
    manifest.testCount += 1;
    const policy = fixturePolicy();
    for (const lane of lanes) {
      assert.throws(() => selectFixtureLanePaths(manifest, lane, false, "win32", "x64", policy),
        /Windows lane union differs from admitted canonical inventory/u);
    }
    policy.lanes.a.push(added);
    const before = structuredClone(policy);
    const selected = lanes.flatMap((lane) => selectFixtureLanePaths(manifest, lane, false, "win32", "x64", policy));
    assert.equal(selected.filter((file) => file === added).length, 1);
    assert.ok(!selected.includes("tests/coverage-only.test.mjs"));
    assert.deepEqual(policy, before);
  }
});

test("runtime Windows policy rejects open, malformed and unsupported configuration", () => {
  const policy = fixturePolicy();
  const invalid: readonly [string, unknown][] = [
    ["null policy", null],
    ["array policy", []],
    ["missing policy fields", { schemaVersion: 1 }],
    ["extra policy field", { ...policy, extra: true }],
    ["unsupported schema", { ...policy, schemaVersion: 2 }],
    ["untyped schema", { ...policy, schemaVersion: "1" }],
    ["null source", { ...policy, source: null }],
    ["missing source field", { ...policy, source: { runId: 1, headSha: "a".repeat(40) } }],
    ["extra source field", { ...policy, source: { ...policy.source, extra: true } }],
    ["invalid run", { ...policy, source: { ...policy.source, runId: 0 } }],
    ["fractional run", { ...policy, source: { ...policy.source, runId: 1.5 } }],
    ["unsafe run", { ...policy, source: { ...policy.source, runId: Number.MAX_SAFE_INTEGER + 1 } }],
    ["incomplete head", { ...policy, source: { ...policy.source, headSha: "a" } }],
    ["empty strategy", { ...policy, source: { ...policy.source, strategy: " " } }],
    ["null lanes", { ...policy, lanes: null }],
    ["array lanes", { ...policy, lanes: [] }],
    ["missing lane", { ...policy, lanes: Object.fromEntries(Object.entries(policy.lanes)
      .filter(([lane]) => lane !== "e")) }],
    ["unknown lane", { ...policy, lanes: { ...policy.lanes, f: ["tests/h.test.mjs"] } }],
    ["non-array paths", { ...policy, lanes: { ...policy.lanes, a: "tests/a.test.mjs" } }],
    ["non-string path", { ...policy, lanes: { ...policy.lanes, a: [1] } }],
    ["empty path", { ...policy, lanes: { ...policy.lanes, a: [""] } }],
  ];
  for (const [label, input] of invalid) {
    assert.throws(() => selectFixtureLanePaths(fixture(), "a", false, "win32", "x64", input),
      /Windows test partition is invalid/u, label);
  }
});

test("every lane rejects policy omission, duplicate, raw-only, Linux-only and loader contamination", () => {
  const policy = fixturePolicy();
  const invalid: readonly [string, unknown][] = [
    ["missing canonical path", { ...policy.lanes, a: ["tests/a.test.mjs"] }],
    ["duplicate within lane", { ...policy.lanes, a: [...policy.lanes.a, "tests/a.test.mjs"] }],
    ["duplicate across lanes", { ...policy.lanes, b: [...policy.lanes.b, "tests/a.test.mjs"] }],
    ["coverage-only path", { ...policy.lanes, a: [...policy.lanes.a, "tests/coverage-only.test.mjs"] }],
    ["Linux-only path", { ...policy.lanes, a: [...policy.lanes.a, linuxOnly[0]] }],
    ["uninventoried path", { ...policy.lanes, a: [...policy.lanes.a, "tests/alien.test.mjs"] }],
    ["contaminated loader lane", { ...policy.lanes, c: [loader, "tests/remainder.test.mjs"] }],
    ["moved loader", { ...policy.lanes, a: [...policy.lanes.a, loader], c: ["tests/remainder.test.mjs"] }],
  ];
  for (const [label, lanePolicy] of invalid) {
    for (const lane of lanes) {
      assert.throws(() => selectFixtureLanePaths(fixture(), lane, false, "win32", "x64",
        { ...policy, lanes: lanePolicy }), /Windows test partition is invalid/u, `${label}: ${lane}`);
    }
  }
});

test("Windows selection rejects partial, unknown and duplicated inventory before dispatch", () => {
  const mutations: readonly [string, (manifest: ReturnType<typeof fixture>) => void][] = [
    ["missing canonical id", (manifest) => { manifest.shards.delete("4"); }],
    ["unknown canonical id", (manifest) => { manifest.shards.set("9", ["tests/alien.test.mjs"]); }],
    ["missing coverage id", (manifest) => { manifest.coverageShards.delete("2"); }],
    ["unknown coverage id", (manifest) => { manifest.coverageShards.set("9", ["tests/alien.test.mjs"]); }],
    ["unknown addition id", (manifest) => { manifest.coverageConfig.additionalTestsByShard["9"] = []; }],
    ["partial canonical projection", (manifest) => { manifest.shards.get("3")!.pop(); }],
    ["partial full inventory", (manifest) => {
      manifest.shards.get("3")!.pop();
      manifest.coverageShards.get("3")!.pop();
    }],
    ["stale coverage addition", (manifest) => { manifest.coverageConfig.additionalTestsByShard["2"] = []; }],
    ["duplicate canonical assignment", (manifest) => {
      const duplicated = manifest.shards.get("1")![0]!;
      manifest.shards.get("2")!.unshift(duplicated);
      manifest.coverageShards.get("2")!.unshift(duplicated);
    }],
    ["duplicate test identity", (manifest) => { manifest.tests.push(manifest.tests[0]!); manifest.testCount += 1; }],
    ["uninventoried selection", (manifest) => { manifest.tests.pop(); manifest.testCount -= 1; }],
    ["missing selection", (manifest) => { manifest.tests.push("tests/unassigned.test.mjs"); manifest.testCount += 1; }],
    ["inconsistent test count", (manifest) => { manifest.testCount += 1; }],
  ];
  for (const [label, mutate] of mutations) {
    const manifest = fixture();
    mutate(manifest);
    assert.throws(() => selectFixtureLanePaths(manifest, "a", false, "win32", "x64"),
      /Windows test partition is invalid/u, label);
  }
});

test("missing or moved pinned loader and an empty residual lane cannot dispatch", () => {
  for (const destination of [undefined, "2"]) {
    const manifest = fixture();
    for (const shards of [manifest.shards, manifest.coverageShards]) {
      shards.set("3", shards.get("3")!.filter((file) => file !== loader));
    }
    if (destination === undefined) {
      manifest.tests = manifest.tests.filter((file) => file !== loader);
      manifest.testCount -= 1;
    } else {
      manifest.shards.get(destination)!.unshift(loader);
      manifest.coverageShards.get(destination)!.unshift(loader);
    }
    assert.throws(() => selectFixtureLanePaths(manifest, "a", false, "win32", "x64"),
      /pinned loader test must remain in canonical shard 3/u);
  }
  const policy = fixturePolicy();
  policy.lanes.e = [];
  assert.throws(() => selectFixtureLanePaths(fixture(), "a", false, "win32", "x64", policy),
    /lane e requires unique non-empty test paths/u);
});

test("Windows selection retains the managed-platform inventory authority", () => {
  const manifest = fixture();
  const removed = linuxOnly[0]!;
  for (const shards of [manifest.shards, manifest.coverageShards]) {
    shards.set("4", shards.get("4")!.filter((file) => file !== removed));
  }
  manifest.tests = manifest.tests.filter((file) => file !== removed);
  manifest.testCount -= 1;
  assert.throws(() => selectFixtureLanePaths(manifest, "a", false, "win32", "x64"),
    /platform policy review/u);
});

test("closed Windows CLI preserves shard mode and rejects invalid dispatch and coverage", () => {
  const manifest = fixture();
  const parsed = parseTestShardArguments(["--", "--windows-lane", "e", "--timing-output", "test-timing"]);
  assert.equal(parsed.windowsLane, "e");
  assert.deepEqual(parsed.ids, []);
  assert.equal(parsed.evidenceDirectory, undefined);
  assert.deepEqual(parseTestShardArguments(["--shards", "1,3"]).ids, ["1", "3"]);
  for (const lane of ["", "A", "f", "g", "h", "i", "j", "1", "a,b", "a,a"]) {
    assert.throws(() => parseTestShardArguments(["--windows-lane", lane]), /Windows lane must be exactly one/u);
    assert.throws(() => selectFixtureLanePaths(manifest, lane, false, "win32", "x64"), /Windows lane must be exactly one/u);
  }
  for (const args of [
    [],
    ["--windows-lane"],
    ["--unknown", "a"],
    ["--shards", "1", "--windows-lane", "a"],
    ["--windows-lane", "a", "--windows-lane", "b"],
    ["--windows-lane", "a", "--coverage-evidence-dir", ".coverage-evidence/windows-a",
      "--head-sha", "a".repeat(40)],
  ]) {
    assert.throws(() => parseTestShardArguments(args));
  }
  for (const ids of ["", "0", "9", "1,1", "1,2,3,4,5,6,7,8,9"]) {
    assert.throws(() => parseTestShardArguments(["--shards", ids]), /Shard ids must be unique/u);
  }
  for (const platform of ["linux", "darwin"] as const) {
    assert.throws(() => selectFixtureLanePaths(manifest, "a", false, platform, "x64"),
      /Windows lanes require win32 dispatch/u);
  }
  assert.throws(() => selectFixtureLanePaths(manifest, "a", true, "win32", "x64"),
    /cannot collect raw coverage evidence/u);
});

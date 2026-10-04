import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateTestManifests } from "../scripts/check-test-manifests.mjs";
import { parseTestShardArguments, selectTestShardPaths } from "../scripts/run-test-shard.mjs";
import {
  selectWindowsTestLanePaths,
  type WindowsTestManifest,
} from "../scripts/windows-test-partitions.mts";

const lanes = ["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const;
const loader = "tests/source-dependency-loader-cli.test.mjs";
const linuxOnly = [
  "packages/docs-protocol-agent-teams/tests/managed-runtime-observation.test.mjs",
  "packages/docs-protocol-agent-teams/tests/managed-runtime-process.test.mjs",
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

test("nine Windows lanes retain exact real canonical inventory and mandatory files", async () => {
  const manifest = await repositoryManifest();
  const before = structuredClone(manifest);
  const ids = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const canonical = [...manifest.shards.values()].flat();
  const admitted = canonical.filter((file) => !linuxOnly.includes(file));
  const byLane = new Map<string, readonly string[]>();
  for (const lane of lanes) {
    byLane.set(lane, selectWindowsTestLanePaths(manifest, lane, false, "win32", "x64"));
  }
  const selected = [...byLane.values()].flat();
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.toSorted(), admitted.toSorted());
  assert.deepEqual(byLane.get("c"), [loader]);
  for (const [lane, id] of [["a", "1"], ["b", "2"], ["d", "4"], ["f", "5"], ["g", "6"], ["h", "7"], ["i", "8"]] as const) {
    assert.deepEqual(byLane.get(lane), selectTestShardPaths(manifest, [id], false, "win32", "x64"));
  }
  assert.deepEqual(byLane.get("e"), manifest.shards.get("3")!
    .filter((file) => file !== loader && !linuxOnly.includes(file)));
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

test("new canonical files retain total Windows coverage without admitting coverage-only suites", () => {
  for (const id of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
    const manifest = fixture();
    const added = `tests/future-shard-${id}.test.mts`;
    manifest.shards.get(id)!.push(added);
    manifest.coverageShards.set(id, [...manifest.shards.get(id)!,
      ...manifest.coverageConfig.additionalTestsByShard[id]!]);
    manifest.tests.push(added);
    manifest.testCount += 1;
    const selected = lanes.flatMap((lane) => selectWindowsTestLanePaths(manifest, lane, false, "win32", "x64"));
    assert.equal(selected.filter((file) => file === added).length, 1);
    assert.ok(!selected.includes("tests/coverage-only.test.mjs"));
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
    assert.throws(() => selectWindowsTestLanePaths(manifest, "a", false, "win32", "x64"),
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
    assert.throws(() => selectWindowsTestLanePaths(manifest, "a", false, "win32", "x64"),
      /pinned loader test must remain in canonical shard 3/u);
  }
  const manifest = fixture();
  const remainder = "tests/remainder.test.mjs";
  for (const shards of [manifest.shards, manifest.coverageShards]) {
    shards.set("3", shards.get("3")!.filter((file) => file !== remainder));
  }
  manifest.tests = manifest.tests.filter((file) => file !== remainder);
  manifest.testCount -= 1;
  assert.throws(() => selectWindowsTestLanePaths(manifest, "a", false, "win32", "x64"),
    /lane e cannot dispatch an empty qualification/u);
});

test("Windows selection retains the managed-platform inventory authority", () => {
  const manifest = fixture();
  const removed = linuxOnly[0]!;
  for (const shards of [manifest.shards, manifest.coverageShards]) {
    shards.set("4", shards.get("4")!.filter((file) => file !== removed));
  }
  manifest.tests = manifest.tests.filter((file) => file !== removed);
  manifest.testCount -= 1;
  assert.throws(() => selectWindowsTestLanePaths(manifest, "a", false, "win32", "x64"),
    /platform policy review/u);
});

test("closed Windows CLI preserves shard mode and rejects invalid dispatch and coverage", () => {
  const manifest = fixture();
  const parsed = parseTestShardArguments(["--", "--windows-lane", "e", "--timing-output", "test-timing"]);
  assert.equal(parsed.windowsLane, "e");
  assert.deepEqual(parsed.ids, []);
  assert.equal(parsed.evidenceDirectory, undefined);
  assert.deepEqual(parseTestShardArguments(["--shards", "1,3"]).ids, ["1", "3"]);
  for (const lane of ["", "A", "j", "1", "a,b", "a,a"]) {
    assert.throws(() => parseTestShardArguments(["--windows-lane", lane]), /Windows lane must be exactly one/u);
    assert.throws(() => selectWindowsTestLanePaths(manifest, lane, false, "win32", "x64"), /Windows lane must be exactly one/u);
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
    assert.throws(() => selectWindowsTestLanePaths(manifest, "a", false, platform, "x64"),
      /Windows lanes require win32 dispatch/u);
  }
  assert.throws(() => selectWindowsTestLanePaths(manifest, "a", true, "win32", "x64"),
    /cannot collect raw coverage evidence/u);
});

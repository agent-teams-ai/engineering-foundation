import { readFileSync } from "node:fs";

import { selectTestPathsForPlatform } from "./check-test-manifests.mjs";

export const WINDOWS_TEST_LANES = Object.freeze(["a", "b", "c", "d", "e"] as const);
export type WindowsTestLane = (typeof WINDOWS_TEST_LANES)[number];
const shardIds = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
const loaderTest = "tests/source-dependency-loader-cli.test.mjs";
const defaultWindowsLanePolicy: unknown = JSON.parse(readFileSync(
  new URL("../tests/manifests/windows-lanes.v1.json", import.meta.url), "utf8"));

export interface WindowsTestManifest {
  readonly tests: readonly string[];
  readonly testCount: number;
  readonly shards: ReadonlyMap<string, readonly string[]>;
  readonly coverageShards: ReadonlyMap<string, readonly string[]>;
  readonly coverageConfig: {
    readonly additionalTestsByShard: Readonly<Record<string, readonly string[]>>;
  };
}

export function requireWindowsTestLane(lane: string): asserts lane is WindowsTestLane {
  if (!(WINDOWS_TEST_LANES as readonly string[]).includes(lane)) {
    throw new Error("Windows lane must be exactly one of a, b, c, d, e");
  }
}

function fail(message: string): never {
  throw new Error(`Windows test partition is invalid: ${message}`);
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    fail(`${label} keys must be exactly ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function parseWindowsLanePolicy(input: unknown): ReadonlyMap<WindowsTestLane, readonly string[]> {
  const policy = exactObject(input, ["schemaVersion", "source", "lanes"], "lane policy");
  if (policy.schemaVersion !== 1) { fail("lane policy schemaVersion must be 1"); }
  const source = exactObject(policy.source, ["runId", "headSha", "strategy"], "lane policy source");
  if (typeof source.runId !== "number" || !Number.isSafeInteger(source.runId) || source.runId <= 0 ||
      typeof source.headSha !== "string" || !/^[a-f0-9]{40}$/u.test(source.headSha) ||
      typeof source.strategy !== "string" || source.strategy.trim() === "") {
    fail("lane policy source requires a run ID, full head SHA and strategy");
  }
  const lanes = exactObject(policy.lanes, WINDOWS_TEST_LANES, "lane policy lanes");
  const parsed = new Map<WindowsTestLane, readonly string[]>();
  for (const lane of WINDOWS_TEST_LANES) {
    const files = lanes[lane];
    requirePaths(files, `lane ${lane}`);
    parsed.set(lane, files);
  }
  if (parsed.get("c")!.length !== 1 || parsed.get("c")![0] !== loaderTest) {
    fail("lane c must contain only the pinned loader test");
  }
  return parsed;
}

function requireShardIds(ids: readonly string[], label: string): void {
  if (ids.length !== shardIds.length || shardIds.some((id) => !ids.includes(id))) {
    fail(`${label} ids must be exactly 1 through 8`);
  }
}

function requirePaths(files: unknown, label: string, allowEmpty = false): asserts files is readonly string[] {
  if (!Array.isArray(files) || (!allowEmpty && files.length === 0) ||
      files.some((file) => typeof file !== "string" || file === "") ||
      new Set(files).size !== files.length) {
    fail(`${label} requires unique non-empty test paths`);
  }
}

function canonicalInventory(manifest: WindowsTestManifest): readonly string[] {
  requirePaths(manifest.tests, "test inventory");
  if (manifest.testCount !== manifest.tests.length) {
    fail("test count differs from test inventory");
  }
  if (!(manifest.shards instanceof Map) || !(manifest.coverageShards instanceof Map)) {
    fail("canonical and coverage shards must be maps");
  }
  requireShardIds([...manifest.shards.keys()], "canonical shard");
  requireShardIds([...manifest.coverageShards.keys()], "coverage shard");
  const additions = manifest.coverageConfig?.additionalTestsByShard;
  if (additions === null || typeof additions !== "object" || Array.isArray(additions)) {
    fail("coverage additions must be an object");
  }
  requireShardIds(Object.keys(additions), "coverage addition");
  const canonical: string[] = [];
  const full: string[] = [];
  for (const id of shardIds) {
    const files = manifest.shards.get(id)!;
    const extra = additions[id]!;
    const coverage = manifest.coverageShards.get(id)!;
    requirePaths(files, `canonical shard ${id}`);
    requirePaths(extra, `coverage additions ${id}`, true);
    requirePaths(coverage, `coverage shard ${id}`);
    const projection = [...files, ...extra];
    if (coverage.length !== projection.length ||
        coverage.some((file: string, index: number) => file !== projection[index])) {
      fail(`coverage shard ${id} differs from its canonical projection`);
    }
    canonical.push(...files);
    full.push(...projection);
  }
  requirePaths(full, "full shard inventory");
  const inventory = new Set(manifest.tests);
  if (full.length !== inventory.size || full.some((file) => !inventory.has(file))) {
    fail("full shard inventory differs from test inventory");
  }
  if (!manifest.shards.get("3")!.includes(loaderTest)) {
    fail("pinned loader test must remain in canonical shard 3");
  }
  return canonical;
}

export function selectWindowsTestLanePaths(
  manifest: WindowsTestManifest,
  lane: string,
  coverageEvidenceEnabled = false,
  {
    platform = process.platform, architecture = process.arch, policy = defaultWindowsLanePolicy,
  }: Readonly<{ platform?: NodeJS.Platform; architecture?: typeof process.arch; policy?: unknown }> = {},
): readonly string[] {
  requireWindowsTestLane(lane);
  if (coverageEvidenceEnabled) {
    throw new Error("Windows lanes cannot collect raw coverage evidence");
  }
  if (platform !== "win32") {
    throw new Error("Windows lanes require win32 dispatch");
  }
  const canonical = canonicalInventory(manifest);
  const admitted = selectTestPathsForPlatform(manifest, canonical, platform, architecture);
  const admittedSet = new Set<string>(admitted);
  // Parse runtime configuration without admitting paths by filtering: stale or
  // incomplete policies must fail before any lane can dispatch.
  const candidates = parseWindowsLanePolicy(policy);
  const partitions = new Map<WindowsTestLane, readonly string[]>();
  const assigned: string[] = [];
  for (const [id, files] of candidates) {
    if (files.some((file) => !admittedSet.has(file))) {
      fail(`lane ${id} contains a path outside admitted canonical inventory`);
    }
    partitions.set(id, Object.freeze([...files]));
    assigned.push(...files);
  }
  requirePaths(assigned, "Windows lane union");
  if (assigned.length !== admitted.length || assigned.some((file) => !admittedSet.has(file))) {
    fail("Windows lane union differs from admitted canonical inventory");
  }
  return partitions.get(lane)!;
}

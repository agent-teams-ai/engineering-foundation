import { selectTestPathsForPlatform } from "./check-test-manifests.mjs";

export const WINDOWS_TEST_LANES = Object.freeze(["a", "b", "c", "d", "e"] as const);
export type WindowsTestLane = (typeof WINDOWS_TEST_LANES)[number];
const shardIds = ["1", "2", "3", "4"] as const;
const loaderTest = "tests/source-dependency-loader-cli.test.mjs";

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

function requireShardIds(ids: readonly string[], label: string): void {
  if (ids.length !== shardIds.length || shardIds.some((id) => !ids.includes(id))) {
    fail(`${label} ids must be exactly 1, 2, 3, and 4`);
  }
}

function requirePaths(files: readonly string[], label: string, allowEmpty = false): void {
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
  platform: NodeJS.Platform = process.platform,
  architecture: typeof process.arch = process.arch,
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
  const candidates = new Map<WindowsTestLane, readonly string[]>([
    ["a", manifest.shards.get("1")!],
    ["b", manifest.shards.get("2")!],
    ["c", [loaderTest]],
    ["d", manifest.shards.get("4")!],
    ["e", manifest.shards.get("3")!.filter((file) => file !== loaderTest)],
  ]);
  const partitions = new Map<WindowsTestLane, readonly string[]>();
  const assigned: string[] = [];
  for (const [id, files] of candidates) {
    const selected = files.filter((file) => admittedSet.has(file));
    if (selected.length === 0) {
      fail(`lane ${id} cannot dispatch an empty qualification`);
    }
    partitions.set(id, Object.freeze(selected));
    assigned.push(...selected);
  }
  requirePaths(assigned, "Windows lane union");
  if (assigned.length !== admitted.length || assigned.some((file) => !admittedSet.has(file))) {
    fail("Windows lane union differs from admitted canonical inventory");
  }
  return partitions.get(lane)!;
}

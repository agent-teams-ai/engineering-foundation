import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = dirname(scriptRoot);
const shardManifestPath = join(repositoryRoot, "tests", "manifests", "test-shards.v1.json");
const coverageManifestPath = join(repositoryRoot, "tests", "manifests", "coverage.v1.json");
const portableTestPath = /^tests\/[a-z0-9][a-z0-9.-]*\.test\.mjs$/u;
const windowsReservedTestName = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function fail(message) {
  throw new Error(`Test manifest is invalid: ${message}`);
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.join("\0") !== expected.join("\0")) {
    fail(`${label} keys must be exactly ${expected.join(", ")}`);
  }
}

function validatePath(path, label) {
  if (typeof path !== "string" || !portableTestPath.test(path)) {
    fail(`${label} must be a portable top-level tests/*.test.mjs path: ${String(path)}`);
  }
  const filename = path.slice("tests/".length);
  if (windowsReservedTestName.test(filename)) {
    fail(`${label} uses a Windows-reserved filename: ${path}`);
  }
  const absolute = resolve(repositoryRoot, ...path.split("/"));
  const testRoot = `${resolve(repositoryRoot, "tests")}${sep}`;
  if (!absolute.startsWith(testRoot)) {
    fail(`${label} escapes the tests directory: ${path}`);
  }
}

function validateShardHeader(shardManifest) {
  assertExactKeys(shardManifest, ["schemaVersion", "source", "shards"], "shard manifest");
  if (shardManifest.schemaVersion !== 1) {
    fail("unsupported shard schemaVersion");
  }
  assertExactKeys(shardManifest.source, ["runId", "headSha", "strategy"], "shard source");
  if (!Number.isSafeInteger(shardManifest.source.runId) || shardManifest.source.runId < 1) {
    fail("source.runId must be a positive safe integer");
  }
  if (!/^[a-f0-9]{40}$/u.test(shardManifest.source.headSha)) {
    fail("source.headSha must be a full lowercase Git commit SHA");
  }
  if (typeof shardManifest.source.strategy !== "string" || shardManifest.source.strategy === "") {
    fail("source.strategy must be non-empty");
  }
  if (!Array.isArray(shardManifest.shards) || shardManifest.shards.length !== 4) {
    fail("exactly four shards are required");
  }
}

export function validateTestManifestData({ shardManifest, coverageManifest, testPaths }) {
  validateShardHeader(shardManifest);

  const expectedShardIds = ["1", "2", "3", "4"];
  const shardIds = [];
  const assigned = [];
  for (const [index, shard] of shardManifest.shards.entries()) {
    assertExactKeys(shard, ["id", "tests"], `shards[${index}]`);
    if (typeof shard.id !== "string") {
      fail(`shards[${index}].id must be a string`);
    }
    shardIds.push(shard.id);
    if (!Array.isArray(shard.tests) || shard.tests.length === 0) {
      fail(`shard ${String(shard.id)} must contain tests`);
    }
    for (const path of shard.tests) {
      validatePath(path, `shard ${String(shard.id)}`);
      assigned.push(path);
    }
  }
  if (shardIds.toSorted().join("\0") !== expectedShardIds.join("\0")) {
    fail("shard ids must be exactly 1, 2, 3, and 4");
  }
  if (new Set(assigned).size !== assigned.length) {
    fail("a test is assigned more than once");
  }

  const sortedAssigned = assigned.toSorted();
  const sortedTests = [...testPaths].toSorted();
  if (sortedAssigned.join("\0") !== sortedTests.join("\0")) {
    const assignedSet = new Set(assigned);
    const testSet = new Set(testPaths);
    const missing = sortedTests.filter((path) => !assignedSet.has(path));
    const extra = sortedAssigned.filter((path) => !testSet.has(path));
    fail(`shard union differs from test files; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`);
  }

  assertExactKeys(coverageManifest, ["schemaVersion", "tests"], "coverage manifest");
  if (coverageManifest.schemaVersion !== 1) {
    fail("unsupported coverage schemaVersion");
  }
  if (!Array.isArray(coverageManifest.tests) || coverageManifest.tests.length === 0) {
    fail("coverage tests must be a non-empty array");
  }
  if (new Set(coverageManifest.tests).size !== coverageManifest.tests.length) {
    fail("coverage manifest contains a duplicate");
  }
  const testSet = new Set(testPaths);
  for (const path of coverageManifest.tests) {
    validatePath(path, "coverage test");
    if (!testSet.has(path)) {
      fail(`coverage test does not exist: ${path}`);
    }
  }

  return Object.freeze({
    coverageTests: Object.freeze([...coverageManifest.tests]),
    shards: new Map(shardManifest.shards.map((shard) => [shard.id, Object.freeze([...shard.tests])])),
    testCount: testPaths.length,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function validateTestManifests() {
  const testsRoot = join(repositoryRoot, "tests");
  const entries = await readdir(testsRoot, { withFileTypes: true, recursive: true });
  const testPaths = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".test.mjs")) {
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      fail(`unsupported test entry: ${entry.name}`);
    }
    const parentPath = entry.parentPath ?? entry.path;
    const path = join(parentPath, entry.name);
    const relativePath = path.slice(`${testsRoot}${sep}`.length).split(sep).join("/");
    if (relativePath.includes("/")) {
      fail(`nested test files are prohibited: tests/${relativePath}`);
    }
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      fail(`test files may not be symlinks: tests/${entry.name}`);
    }
    testPaths.push(`tests/${relativePath}`);
  }
  const result = validateTestManifestData({
    shardManifest: await readJson(shardManifestPath),
    coverageManifest: await readJson(coverageManifestPath),
    testPaths,
  });
  return result;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const result = await validateTestManifests();
  process.stdout.write(`Validated ${result.testCount} tests across ${result.shards.size} shards.\n`);
}

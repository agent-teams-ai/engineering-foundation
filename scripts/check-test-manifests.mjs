import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = dirname(scriptRoot);
const shardManifestPath = join(repositoryRoot, "tests", "manifests", "test-shards.v1.json");
const coverageManifestPath = join(repositoryRoot, "tests", "manifests", "coverage.v1.json");
const portableTestPath = /^(?:tests|packages\/docs-protocol\/tests)\/[a-z0-9][a-z0-9.-]*\.test\.mjs$/u;
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
    fail(`${label} must be a portable top-level test path: ${String(path)}`);
  }
  const filename = basename(path);
  if (windowsReservedTestName.test(filename)) {
    fail(`${label} uses a Windows-reserved filename: ${path}`);
  }
  const absolute = resolve(repositoryRoot, ...path.split("/"));
  const allowedRoots = [
    `${resolve(repositoryRoot, "tests")}${sep}`,
    `${resolve(repositoryRoot, "packages", "docs-protocol", "tests")}${sep}`,
  ];
  if (!allowedRoots.some((root) => absolute.startsWith(root))) {
    fail(`${label} escapes the allowed test directories: ${path}`);
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

function validateCoverageManifest(coverageManifest, testPaths) {
  assertExactKeys(
    coverageManifest,
    ["schemaVersion", "tool", "processBootstrap", "include", "exclude", "legacyTests", "thresholds"],
    "coverage manifest",
  );
  if (coverageManifest.schemaVersion !== 2) {
    fail("unsupported coverage schemaVersion");
  }
  assertExactKeys(coverageManifest.tool, ["name", "version"], "coverage tool");
  if (coverageManifest.tool.name !== "c8" || !/^\d+\.\d+\.\d+$/u.test(coverageManifest.tool.version)) {
    fail("coverage tool must pin an exact c8 version");
  }
  if (coverageManifest.processBootstrap !== "scripts/coverage-process-bootstrap.mjs") {
    fail("coverage processBootstrap must pin the test-process boundary");
  }
  for (const key of ["include", "exclude"]) {
    if (!Array.isArray(coverageManifest[key]) || coverageManifest[key].length === 0) {
      fail(`coverage ${key} must be a non-empty array`);
    }
    if (coverageManifest[key].some((value) => typeof value !== "string" || value === "")) {
      fail(`coverage ${key} entries must be non-empty strings`);
    }
    if (new Set(coverageManifest[key]).size !== coverageManifest[key].length) {
      fail(`coverage ${key} contains a duplicate`);
    }
  }
  assertExactKeys(coverageManifest.thresholds, ["branches", "functions", "lines"], "coverage thresholds");
  for (const [key, value] of Object.entries(coverageManifest.thresholds)) {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      fail(`coverage threshold ${key} must be an integer from 1 through 100`);
    }
  }
  if (!Array.isArray(coverageManifest.legacyTests) || coverageManifest.legacyTests.length === 0) {
    fail("coverage legacyTests must be a non-empty array");
  }
  if (new Set(coverageManifest.legacyTests).size !== coverageManifest.legacyTests.length) {
    fail("coverage legacyTests contains a duplicate");
  }
  const testSet = new Set(testPaths);
  for (const path of coverageManifest.legacyTests) {
    validatePath(path, "legacy coverage test");
    if (!testSet.has(path)) {
      fail(`legacy coverage test does not exist: ${path}`);
    }
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

  validateCoverageManifest(coverageManifest, testPaths);

  return Object.freeze({
    coverageConfig: Object.freeze(coverageManifest),
    coverageTests: Object.freeze([...coverageManifest.legacyTests]),
    shards: new Map(shardManifest.shards.map((shard) => [shard.id, Object.freeze([...shard.tests])])),
    testCount: testPaths.length,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function validateTestManifests() {
  const testPaths = [];
  const testRoots = ["tests", "packages/docs-protocol/tests"];
  for (const relativeRoot of testRoots) {
    const testsRoot = resolve(repositoryRoot, ...relativeRoot.split("/"));
    const entries = await readdir(testsRoot, { withFileTypes: true, recursive: true });
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
        fail(`nested test files are prohibited: ${relativeRoot}/${relativePath}`);
      }
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        fail(`test files may not be symlinks: ${relativeRoot}/${entry.name}`);
      }
      testPaths.push(`${relativeRoot}/${relativePath}`);
    }
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

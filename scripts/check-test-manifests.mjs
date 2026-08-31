import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = dirname(scriptRoot);
const shardManifestPath = join(repositoryRoot, "tests", "manifests", "test-shards.v1.json");
const coverageManifestPath = join(repositoryRoot, "tests", "manifests", "coverage.v1.json");
const portablePackageRoot = /^packages\/[a-z0-9][a-z0-9.-]*$/u;
const portableTestFilename = /^[a-z0-9][a-z0-9.-]*\.test\.mjs$/u;
const windowsReservedTestName = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function packageRootsForPackages(packages) {
  if (!Array.isArray(packages)) {
    fail("publishable packages must be an array");
  }
  const roots = [];
  for (const entry of packages) {
    if (typeof entry?.root !== "string" || !portablePackageRoot.test(entry.root)) {
      fail(`publishable package root is not bounded and portable: ${String(entry?.root)}`);
    }
    roots.push(entry.root);
  }
  if (new Set(roots).size !== roots.length) {
    fail("publishable package roots must be unique");
  }
  return roots;
}

export function testRootsForPackages(packages) {
  const roots = ["tests", ...packageRootsForPackages(packages).map((root) => `${root}/tests`)];
  return Object.freeze(roots);
}

export const testRoots = testRootsForPackages(PUBLISHABLE_PACKAGES);

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

function compareDirectoryEntries(left, right) {
  const leftPath = `${left.parentPath ?? left.path}/${left.name}`;
  const rightPath = `${right.parentPath ?? right.path}/${right.name}`;
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

function validatePath(path, label, allowedTestRoots) {
  const relativeRoot = typeof path === "string"
    ? allowedTestRoots.find((candidate) => path.startsWith(`${candidate}/`))
    : undefined;
  const filename = relativeRoot === undefined ? undefined : path.slice(relativeRoot.length + 1);
  if (filename === undefined || filename.includes("/") || !portableTestFilename.test(filename)) {
    fail(`${label} must be a portable top-level test path: ${String(path)}`);
  }
  if (windowsReservedTestName.test(filename)) {
    fail(`${label} uses a Windows-reserved filename: ${path}`);
  }
  const absolute = resolve(repositoryRoot, ...path.split("/"));
  const allowedRoots = allowedTestRoots.map((root) =>
    `${resolve(repositoryRoot, ...root.split("/"))}${sep}`);
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

function validateCoverageAdditionalTests(value, shardIds, allowedTestRoots) {
  assertExactKeys(value, shardIds, "coverage additionalTestsByShard");
  const additionalTests = new Map();
  for (const shardId of shardIds) {
    const tests = value[shardId];
    if (!Array.isArray(tests)) {
      fail(`coverage additionalTestsByShard.${shardId} must be an array`);
    }
    for (const path of tests) {
      validatePath(path, `coverage shard ${shardId} addition`, allowedTestRoots);
    }
    additionalTests.set(shardId, Object.freeze([...tests]));
  }
  return additionalTests;
}

function validateCoverageProjection(coverageManifest, packages) {
  const packageRoots = packageRootsForPackages(packages);
  for (const [key, extension] of [["include", "js"], ["exclude", "d.ts"]]) {
    const actual = coverageManifest[key];
    if (!Array.isArray(actual) || actual.length === 0) {
      fail(`coverage ${key} must be a non-empty array`);
    }
    if (actual.some((value) => typeof value !== "string" || value === "")) {
      fail(`coverage ${key} entries must be non-empty strings`);
    }
    if (new Set(actual).size !== actual.length) {
      fail(`coverage ${key} contains a duplicate`);
    }

    // Validated publishable-package order is the canonical stored projection
    // order, so a membership change cannot be hidden by another package list.
    const expected = packageRoots.map((root) => `${root}/dist/**/*.${extension}`);
    if (actual.join("\0") !== expected.join("\0")) {
      const actualSet = new Set(actual);
      const expectedSet = new Set(expected);
      const missing = expected.filter((pattern) => !actualSet.has(pattern));
      const unexpected = actual.filter((pattern) => !expectedSet.has(pattern));
      const orderDiffers = missing.length === 0 && unexpected.length === 0;
      fail(
        `coverage ${key} must exactly project publishable package roots in canonical order; ` +
        `missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]` +
        (orderDiffers ? ", order differs" : ""),
      );
    }
  }
}

function validateCoverageManifest(coverageManifest, testPaths, shardIds, packages, allowedTestRoots) {
  assertExactKeys(
    coverageManifest,
    [
      "schemaVersion",
      "tool",
      "processBootstrap",
      "include",
      "exclude",
      "additionalTestsByShard",
      "legacyTests",
      "thresholds",
      "evidenceThresholds",
    ],
    "coverage manifest",
  );
  if (coverageManifest.schemaVersion !== 3) {
    fail("unsupported coverage schemaVersion");
  }
  assertExactKeys(coverageManifest.tool, ["name", "version"], "coverage tool");
  if (coverageManifest.tool.name !== "c8" || !/^\d+\.\d+\.\d+$/u.test(coverageManifest.tool.version)) {
    fail("coverage tool must pin an exact c8 version");
  }
  if (coverageManifest.processBootstrap !== "scripts/coverage-process-bootstrap.mjs") {
    fail("coverage processBootstrap must pin the test-process boundary");
  }
  validateCoverageProjection(coverageManifest, packages);
  const additionalTests = validateCoverageAdditionalTests(
    coverageManifest.additionalTestsByShard,
    shardIds,
    allowedTestRoots,
  );
  for (const authority of ["thresholds", "evidenceThresholds"]) {
    assertExactKeys(
      coverageManifest[authority],
      ["branches", "functions", "lines"],
      `coverage ${authority}`,
    );
    for (const [key, value] of Object.entries(coverageManifest[authority])) {
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        fail(`coverage ${authority} ${key} must be an integer from 1 through 100`);
      }
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
    validatePath(path, "legacy coverage test", allowedTestRoots);
    if (!testSet.has(path)) {
      fail(`legacy coverage test does not exist: ${path}`);
    }
  }
  return additionalTests;
}

export function validateTestManifestData({
  shardManifest,
  coverageManifest,
  testPaths,
  packages = PUBLISHABLE_PACKAGES,
}) {
  const allowedTestRoots = testRootsForPackages(packages);
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
      validatePath(path, `shard ${String(shard.id)}`, allowedTestRoots);
      assigned.push(path);
    }
  }
  if (shardIds.toSorted().join("\0") !== expectedShardIds.join("\0")) {
    fail("shard ids must be exactly 1, 2, 3, and 4");
  }
  const additionalTests = validateCoverageManifest(
    coverageManifest,
    testPaths,
    expectedShardIds,
    packages,
    allowedTestRoots,
  );
  for (const tests of additionalTests.values()) {
    assigned.push(...tests);
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

  return Object.freeze({
    coverageConfig: Object.freeze(coverageManifest),
    coverageShards: new Map(
      shardManifest.shards.map((shard) => [
        shard.id,
        Object.freeze([...shard.tests, ...(additionalTests.get(shard.id) ?? [])]),
      ]),
    ),
    coverageTests: Object.freeze([...coverageManifest.legacyTests]),
    shards: new Map(shardManifest.shards.map((shard) => [shard.id, Object.freeze([...shard.tests])])),
    tests: Object.freeze([...testPaths]),
    testCount: testPaths.length,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function validateTestManifests() {
  const testPaths = [];
  for (const relativeRoot of testRoots) {
    const testsRoot = resolve(repositoryRoot, ...relativeRoot.split("/"));
    let entries;
    try {
      entries = await readdir(testsRoot, { withFileTypes: true, recursive: true });
    } catch (error) {
      if (relativeRoot !== "tests" && error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries.toSorted(compareDirectoryEntries)) {
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
    packages: PUBLISHABLE_PACKAGES,
  });
  return result;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const result = await validateTestManifests();
  process.stdout.write(`Validated ${result.testCount} tests across ${result.shards.size} shards.\n`);
}

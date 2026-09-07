import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { repositoryRoot, validateTestManifests } from "./check-test-manifests.mjs";
import { materializeValidatedRawCoverage } from "./materialize-validated-coverage.mjs";

export { materializeValidatedRawCoverage } from "./materialize-validated-coverage.mjs";

const executeFile = promisify(execFile);
const shardManifestPath = join(repositoryRoot, "tests", "manifests", "test-shards.v1.json");
const coverageManifestPath = join(repositoryRoot, "tests", "manifests", "coverage.v1.json");
const rawCoverageFilename = /^coverage-\d+-\d+-\d+\.json$/u;
const maximumEvidenceBytes = 1024 * 1024;
const maximumRawFileBytes = 16 * 1024 * 1024;
const maximumRawFiles = 512;
// Native CI shards reach 90 MiB. Keep bounded headroom within the set budget.
const maximumRawShardBytes = 128 * 1024 * 1024;
const maximumRawSetBytes = 256 * 1024 * 1024;

function fail(message) {
  throw new Error(`Coverage evidence is invalid: ${message}`);
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).toSorted().join("\0");
  const expected = [...keys].toSorted().join("\0");
  if (actual !== expected) {
    fail(`${label} keys differ from the protocol`);
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertDigest(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a sha256 digest`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function installedC8Version() {
  const packagePath = join(repositoryRoot, "node_modules", "c8", "package.json");
  return (await readJson(packagePath)).version;
}

export async function loadCoverageProtocol() {
  const manifest = await validateTestManifests();
  const [shardManifest, coverageConfig, toolVersion] = await Promise.all([
    readJson(shardManifestPath),
    readJson(coverageManifestPath),
    installedC8Version(),
  ]);
  if (coverageConfig.tool.version !== toolVersion) {
    fail(`configured c8 ${coverageConfig.tool.version} differs from installed ${toolVersion}`);
  }
  return Object.freeze({
    config: coverageConfig,
    configDigest: sha256(canonicalJson(coverageConfig)),
    manifest,
    testManifestDigest: sha256(canonicalJson(shardManifest)),
    toolVersion,
  });
}

export async function currentHeadSha() {
  const { stdout } = await executeFile("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const headSha = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(headSha)) {
    fail("Git HEAD is not a full lowercase SHA");
  }
  return headSha;
}

export function createEvidenceIdentity({
  configDigest,
  headSha,
  nodeVersion,
  testManifestDigest,
  toolVersion,
}) {
  if (!/^[a-f0-9]{40}$/u.test(headSha)) {
    fail("headSha must be a full lowercase Git SHA");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(nodeVersion)) {
    fail("nodeVersion must be exact");
  }
  assertDigest(configDigest, "configDigest");
  assertDigest(testManifestDigest, "testManifestDigest");
  return Object.freeze({
    configDigest,
    headSha,
    nodeVersion,
    testManifestDigest,
    tool: Object.freeze({ name: "c8", version: toolVersion }),
  });
}

async function requireDirectory(path, label) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail(`${label} must be a real directory`);
  }
}

function sameFileObservation(left, right) {
  return ["dev", "ino", "birthtimeNs", "ctimeNs", "mtimeNs", "nlink", "size"].every(
    (field) => left[field] === right[field],
  );
}

function pathMatchesOpenedFile(pathStats, openedStats) {
  return (
    pathStats.isFile() &&
    !pathStats.isSymbolicLink() &&
    pathStats.dev === openedStats.dev &&
    pathStats.ino === openedStats.ino &&
    pathStats.birthtimeNs === openedStats.birthtimeNs
  );
}

export async function readBoundedRegularFile(path, maximumBytes, label, faultInjector) {
  let handle;
  try {
    const noFollow = process.platform === "win32" ? 0 : fileConstants.O_NOFOLLOW;
    const nonBlocking = process.platform === "win32" ? 0 : fileConstants.O_NONBLOCK;
    handle = await open(
      path,
      fileConstants.O_RDONLY | noFollow | nonBlocking,
    );
    const openedStats = await handle.stat({ bigint: true });
    if (
      !openedStats.isFile() ||
      openedStats.size === 0n ||
      openedStats.size > BigInt(maximumBytes)
    ) {
      fail(`${label} is not a bounded regular file`);
    }
    const buffer = Buffer.allocUnsafe(
      Math.min(maximumBytes + 1, Number(openedStats.size) + 1),
    );
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    await faultInjector?.({ phase: "before-stability-check", path });
    const [finalStats, pathStats] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      offset === 0 ||
      offset > maximumBytes ||
      finalStats.size !== BigInt(offset) ||
      !sameFileObservation(openedStats, finalStats) ||
      !pathMatchesOpenedFile(pathStats, openedStats)
    ) {
      fail(`${label} changed during its bounded read`);
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Coverage evidence is invalid:")) {
      throw error;
    }
    fail(`${label} could not be opened safely`);
  } finally {
    await handle?.close();
  }
}

export async function requireContainedRealDirectory(path, root, label) {
  await requireDirectory(path, label);
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(path)]);
  const expectedRealDirectory = resolvePath(realRoot, relative(resolvePath(root), resolvePath(path)));
  if (
    realDirectory !== expectedRealDirectory ||
    (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}${sep}`))
  ) {
    fail(`${label} must not traverse a symlink outside its root`);
  }
}

async function rawFileRecords(rawDirectory, expectedTests) {
  await requireDirectory(rawDirectory, "raw coverage directory");
  const entries = await readdir(rawDirectory, { withFileTypes: true });
  if (entries.length === 0) {
    fail("raw coverage directory is empty");
  }
  if (entries.length > maximumRawFiles) {
    fail(`raw coverage directory exceeds ${maximumRawFiles} files`);
  }
  const sortedEntries = entries.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const boundedEntries = [];
  for (const entry of sortedEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !rawCoverageFilename.test(entry.name)) {
      fail(`unexpected raw coverage entry ${entry.name}`);
    }
    boundedEntries.push({ entry, path: join(rawDirectory, entry.name) });
  }
  let totalBytes = 0;
  const readEntries = [];
  for (const { entry, path } of boundedEntries) {
    const bytes = await readBoundedRegularFile(
      path,
      maximumRawFileBytes,
      `raw coverage file ${entry.name}`,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumRawShardBytes) {
      fail("raw coverage directory exceeds its total byte budget");
    }
    readEntries.push({ bytes, entry });
  }
  const records = [];
  const expectedTestByUrl = new Map(
    expectedTests.map((testPath) => [
      pathToFileURL(join(repositoryRoot, ...testPath.split("/"))).href,
      testPath,
    ]),
  );
  for (const { bytes, entry } of readEntries) {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed.result)) {
      fail(`raw coverage file ${entry.name} has no result array`);
    }
    const matchedTests = [
      ...new Set(
        parsed.result
          .map((script) => expectedTestByUrl.get(script.url))
          .filter((testPath) => testPath !== undefined),
      ),
    ];
    if (matchedTests.length !== 1) {
      fail(`raw coverage file ${entry.name} does not contain exactly one expected shard test`);
    }
    records.push(
      Object.freeze({
        path: `raw/${entry.name}`,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        test: matchedTests[0],
      }),
    );
  }
  const recordedTests = records.map((record) => record.test).toSorted();
  if (recordedTests.join("\0") !== [...expectedTests].toSorted().join("\0")) {
    fail("raw coverage test union differs from the shard manifest");
  }
  return Object.freeze({
    records: Object.freeze(records),
    validatedFiles: Object.freeze(
      readEntries.map(({ bytes, entry }) => Object.freeze({
        bytes, name: entry.name,
      })),
    ),
  });
}

export async function writeShardEvidence({ directory, headSha, shardId }) {
  if ((await currentHeadSha()) !== headSha) {
    fail("supplied head SHA differs from the checked-out Git HEAD");
  }
  const protocol = await loadCoverageProtocol();
  const tests = protocol.manifest.coverageShards.get(shardId);
  if (tests === undefined) {
    fail(`unknown shard ${shardId}`);
  }
  const identity = createEvidenceIdentity({
    configDigest: protocol.configDigest,
    headSha,
    nodeVersion: process.versions.node,
    testManifestDigest: protocol.testManifestDigest,
    toolVersion: protocol.toolVersion,
  });
  const { records: rawFiles } = await rawFileRecords(join(directory, "raw"), tests);
  const evidenceWithoutDigest = {
    schemaVersion: 1,
    identity,
    shard: {
      id: shardId,
      tests,
      testsDigest: sha256(canonicalJson(tests)),
    },
    rawFiles,
  };
  const evidence = {
    ...evidenceWithoutDigest,
    evidenceDigest: sha256(canonicalJson(evidenceWithoutDigest)),
  };
  await writeFile(join(directory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return evidence;
}

function validateEvidenceShape(evidence, expected) {
  assertExactKeys(
    evidence,
    ["schemaVersion", "identity", "shard", "rawFiles", "evidenceDigest"],
    "evidence",
  );
  if (evidence.schemaVersion !== 1) {
    fail("unsupported evidence schemaVersion");
  }
  assertExactKeys(
    evidence.identity,
    ["configDigest", "headSha", "nodeVersion", "testManifestDigest", "tool"],
    "identity",
  );
  assertExactKeys(evidence.identity.tool, ["name", "version"], "identity tool");
  if (canonicalJson(evidence.identity) !== canonicalJson(expected.identity)) {
    fail(`shard ${expected.shardId} has mixed identity`);
  }
  assertExactKeys(evidence.shard, ["id", "tests", "testsDigest"], "shard");
  if (evidence.shard.id !== expected.shardId) {
    fail(`artifact ${expected.shardId} claims shard ${String(evidence.shard.id)}`);
  }
  if (canonicalJson(evidence.shard.tests) !== canonicalJson(expected.tests)) {
    fail(`shard ${expected.shardId} test list differs from the manifest`);
  }
  if (evidence.shard.testsDigest !== sha256(canonicalJson(expected.tests))) {
    fail(`shard ${expected.shardId} test digest differs from the manifest`);
  }
  if (!Array.isArray(evidence.rawFiles) || evidence.rawFiles.length === 0) {
    fail(`shard ${expected.shardId} has no raw files`);
  }
  if (evidence.rawFiles.length !== expected.tests.length) {
    fail(`shard ${expected.shardId} must contain exactly one raw file per test worker`);
  }
  const withoutDigest = {
    schemaVersion: evidence.schemaVersion,
    identity: evidence.identity,
    shard: evidence.shard,
    rawFiles: evidence.rawFiles,
  };
  if (evidence.evidenceDigest !== sha256(canonicalJson(withoutDigest))) {
    fail(`shard ${expected.shardId} evidence digest is invalid`);
  }
}

async function validateArtifactDirectory({ artifactDirectory, identity, shardId, tests }) {
  await requireDirectory(artifactDirectory, `artifact ${shardId}`);
  const entries = (await readdir(artifactDirectory)).toSorted();
  if (entries.join("\0") !== ["evidence.json", "raw"].join("\0")) {
    fail(`artifact ${shardId} must contain exactly evidence.json and raw`);
  }
  const evidencePath = join(artifactDirectory, "evidence.json");
  const evidenceBytes = await readBoundedRegularFile(
    evidencePath,
    maximumEvidenceBytes,
    `artifact ${shardId} evidence.json`,
  );
  const evidence = JSON.parse(evidenceBytes.toString("utf8"));
  validateEvidenceShape(evidence, { identity, shardId, tests });
  const actualRaw = await rawFileRecords(join(artifactDirectory, "raw"), tests);
  if (canonicalJson(actualRaw.records) !== canonicalJson(evidence.rawFiles)) {
    fail(`shard ${shardId} raw files differ from the sidecar`);
  }
  return { artifactDirectory, evidence, validatedFiles: actualRaw.validatedFiles };
}

export async function validateCoverageEvidenceSet({ headSha, inputDirectory }) {
  if ((await currentHeadSha()) !== headSha) {
    fail("supplied head SHA differs from the checked-out Git HEAD");
  }
  const protocol = await loadCoverageProtocol();
  const identity = createEvidenceIdentity({
    configDigest: protocol.configDigest,
    headSha,
    nodeVersion: process.versions.node,
    testManifestDigest: protocol.testManifestDigest,
    toolVersion: protocol.toolVersion,
  });
  await requireDirectory(inputDirectory, "evidence input");
  const shardIds = [...protocol.manifest.shards.keys()].toSorted();
  const expectedNames = shardIds.map(
    (shardId) => `coverage-evidence-${headSha}-shard-${shardId}`,
  );
  const actualNames = (await readdir(inputDirectory)).toSorted();
  if (actualNames.join("\0") !== expectedNames.join("\0")) {
    fail(
      `artifact set must be exactly [${expectedNames.join(", ")}], received [${actualNames.join(", ")}]`,
    );
  }
  const artifacts = [];
  const rawDigests = new Set();
  let totalRawBytes = 0;
  for (const shardId of shardIds) {
    const artifact = await validateArtifactDirectory({
        artifactDirectory: join(
          inputDirectory,
          `coverage-evidence-${headSha}-shard-${shardId}`,
        ),
        identity,
        shardId,
        tests: protocol.manifest.coverageShards.get(shardId),
      });
    totalRawBytes += artifact.evidence.rawFiles.reduce(
      (total, record) => total + record.size,
      0,
    );
    if (totalRawBytes > maximumRawSetBytes) {
      fail("complete evidence set exceeds its total byte budget");
    }
    for (const record of artifact.evidence.rawFiles) {
      if (rawDigests.has(record.sha256)) {
        fail(`raw coverage digest is replayed across shards: ${record.sha256}`);
      }
      rawDigests.add(record.sha256);
    }
    artifacts.push(artifact);
  }
  return Object.freeze({ artifacts, identity, protocol });
}

export async function mergeCoverageEvidence({ headSha, inputDirectory }) {
  const validated = await validateCoverageEvidenceSet({ headSha, inputDirectory });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "foundation-coverage-evidence-"));
  try {
    await materializeValidatedRawCoverage(validated, temporaryDirectory);
    const c8Arguments = [
      "exec",
      "c8",
      "report",
      "--temp-directory",
      temporaryDirectory,
      "--reporter=text-summary",
      "--all",
      "--merge-async",
      "--check-coverage",
      `--lines=${validated.protocol.config.evidenceThresholds.lines}`,
      `--branches=${validated.protocol.config.evidenceThresholds.branches}`,
      `--functions=${validated.protocol.config.evidenceThresholds.functions}`,
      ...validated.protocol.config.include.flatMap((pattern) => ["--include", pattern]),
      ...validated.protocol.config.exclude.flatMap((pattern) => ["--exclude", pattern]),
    ];
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn("pnpm", c8Arguments, {
        cwd: repositoryRoot,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal === null ? 1 : 128));
      });
    });
    if (exitCode !== 0) {
      throw new Error(`c8 coverage report failed with exit code ${exitCode}`);
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export function parseCoverageEvidenceArguments(arguments_) {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const values = new Map();
  for (let index = 0; index < normalizedArguments.length; index += 2) {
    const key = normalizedArguments[index];
    const value = normalizedArguments[index + 1];
    if (!new Set(["--head-sha", "--input"]).has(key) || value === undefined) {
      fail("usage: --input <directory> --head-sha <full-sha>");
    }
    if (values.has(key)) {
      fail(`duplicate argument ${key}`);
    }
    values.set(key, value);
  }
  if (values.size !== 2) {
    fail("usage: --input <directory> --head-sha <full-sha>");
  }
  return Object.freeze({
    headSha: values.get("--head-sha"),
    inputDirectory: resolvePath(repositoryRoot, values.get("--input")),
  });
}

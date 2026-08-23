import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  canonicalJson,
  createEvidenceIdentity,
  currentHeadSha,
  sha256,
  parseCoverageEvidenceArguments,
  readBoundedRegularFile,
  requireContainedRealDirectory,
  validateCoverageEvidenceSet,
  writeShardEvidence,
} from "../scripts/coverage-evidence.mjs";
import {
  parseTestShardArguments,
  selectTestShardPaths,
} from "../scripts/run-test-shard.mjs";
import { validateTestManifests } from "../scripts/check-test-manifests.mjs";

const headSha = await currentHeadSha();
const executeFile = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testManifest = await validateTestManifests();

async function evidenceSet() {
  const root = await mkdtemp(join(tmpdir(), "foundation-coverage-evidence-test-"));
  for (const shardId of ["1", "2", "3", "4"]) {
    const artifact = join(root, `coverage-evidence-${headSha}-shard-${shardId}`);
    const raw = join(artifact, "raw");
    await mkdir(raw, { recursive: true });
    const tests = testManifest.coverageShards.get(shardId);
    for (const [index, testPath] of tests.entries()) {
      const processId = index === 0 ? shardId : `${shardId}${index}`;
      const testUrl = pathToFileURL(join(repositoryRoot, ...testPath.split("/"))).href;
      await writeFile(
        join(raw, `coverage-${processId}-1-0.json`),
        `${JSON.stringify({ result: [{ functions: [], url: testUrl }], timestamp: Number(shardId) * 1000 + index })}\n`,
      );
    }
    await writeShardEvidence({ directory: artifact, headSha, shardId });
  }
  return root;
}

async function rewriteEvidence(path, mutate) {
  const evidence = JSON.parse(await readFile(path, "utf8"));
  mutate(evidence);
  evidence.evidenceDigest = sha256(
    canonicalJson({
      schemaVersion: evidence.schemaVersion,
      identity: evidence.identity,
      shard: evidence.shard,
      rawFiles: evidence.rawFiles,
    }),
  );
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

test("coverage identity is deterministic across object insertion order", () => {
  const values = {
    configDigest: `sha256:${"b".repeat(64)}`,
    headSha,
    nodeVersion: "24.18.0",
    testManifestDigest: `sha256:${"c".repeat(64)}`,
    toolVersion: "12.0.0",
  };
  const identity = createEvidenceIdentity(values);
  const reordered = createEvidenceIdentity({
    toolVersion: values.toolVersion,
    testManifestDigest: values.testManifestDigest,
    nodeVersion: values.nodeVersion,
    headSha: values.headSha,
    configDigest: values.configDigest,
  });
  assert.equal(canonicalJson(identity), canonicalJson(reordered));
});

test("coverage evidence requires the complete exact shard set", async (context) => {
  const root = await evidenceSet();
  context.after(() => rm(root, { force: true, recursive: true }));
  const valid = await validateCoverageEvidenceSet({ headSha, inputDirectory: root });
  assert.equal(valid.artifacts.length, 4);

  await rm(join(root, `coverage-evidence-${headSha}-shard-4`), {
    force: true,
    recursive: true,
  });
  await assert.rejects(
    validateCoverageEvidenceSet({ headSha, inputDirectory: root }),
    /artifact set must be exactly/u,
  );
});

test("coverage evidence rejects a claimed SHA that is not checked out", async (context) => {
  const root = await evidenceSet();
  context.after(() => rm(root, { force: true, recursive: true }));
  await assert.rejects(
    validateCoverageEvidenceSet({ headSha: "b".repeat(40), inputDirectory: root }),
    /differs from the checked-out Git HEAD/u,
  );
});

test("coverage evidence rejects mixed identity and duplicate artifact claims", async (context) => {
  const root = await evidenceSet();
  context.after(() => rm(root, { force: true, recursive: true }));
  const secondSidecar = join(
    root,
    `coverage-evidence-${headSha}-shard-2`,
    "evidence.json",
  );
  await rewriteEvidence(secondSidecar, (evidence) => {
    evidence.identity.headSha = "b".repeat(40);
  });
  await assert.rejects(
    validateCoverageEvidenceSet({ headSha, inputDirectory: root }),
    /mixed identity/u,
  );

  await rewriteEvidence(secondSidecar, (evidence) => {
    evidence.identity.headSha = headSha;
    evidence.shard.id = "1";
  });
  await assert.rejects(
    validateCoverageEvidenceSet({ headSha, inputDirectory: root }),
    /claims shard 1/u,
  );
});

test("coverage evidence rejects raw V8 replay across claimed shards", async (context) => {
  const root = await evidenceSet();
  context.after(() => rm(root, { force: true, recursive: true }));
  const firstRaw = await readFile(
    join(root, `coverage-evidence-${headSha}-shard-1`, "raw", "coverage-1-1-0.json"),
  );
  const secondRawPath = join(
    root,
    `coverage-evidence-${headSha}-shard-2`,
    "raw",
    "coverage-2-1-0.json",
  );
  await writeFile(secondRawPath, firstRaw);
  await rewriteEvidence(
    join(root, `coverage-evidence-${headSha}-shard-2`, "evidence.json"),
    (evidence) => {
      evidence.rawFiles[0].sha256 = sha256(firstRaw);
      evidence.rawFiles[0].size = firstRaw.byteLength;
    },
  );
  await assert.rejects(
    validateCoverageEvidenceSet({ headSha, inputDirectory: root }),
    /does not contain exactly one expected shard test/u,
  );
});

test("coverage evidence rejects raw bytes changed after sidecar creation", async (context) => {
  const root = await evidenceSet();
  context.after(() => rm(root, { force: true, recursive: true }));
  const rawPath = join(
    root,
    `coverage-evidence-${headSha}-shard-3`,
    "raw",
    "coverage-3-1-0.json",
  );
  const changedRaw = JSON.parse(await readFile(rawPath, "utf8"));
  changedRaw.timestamp += 1;
  await writeFile(rawPath, `${JSON.stringify(changedRaw)}\n`);
  await assert.rejects(
    validateCoverageEvidenceSet({ headSha, inputDirectory: root }),
    /raw files differ from the sidecar/u,
  );
});

test("coverage evidence rejects an oversized sidecar before parsing", async (context) => {
  const root = await evidenceSet();
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    join(root, `coverage-evidence-${headSha}-shard-1`, "evidence.json"),
    "x".repeat(1024 * 1024 + 1),
  );
  await assert.rejects(
    validateCoverageEvidenceSet({ headSha, inputDirectory: root }),
    /not a bounded regular file/u,
  );
});

test(
  "bounded evidence reads reject a path swapped after its file handle is opened",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "foundation-coverage-file-swap-"));
    context.after(() => rm(root, { force: true, recursive: true }));
    const path = join(root, "evidence.json");
    const detachedPath = join(root, "detached-evidence.json");
    await writeFile(path, "trusted");

    await assert.rejects(
      readBoundedRegularFile(path, 1024, "swapped evidence", async ({ phase }) => {
        assert.equal(phase, "before-stability-check");
        await rename(path, detachedPath);
        await writeFile(path, "hostile");
      }),
      /changed during its bounded read/u,
    );
    assert.equal(await readFile(detachedPath, "utf8"), "trusted");
    assert.equal(await readFile(path, "utf8"), "hostile");
  },
);

test(
  "coverage evidence containment rejects a symlinked parent path",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "foundation-coverage-contained-root-"));
    const outside = await mkdtemp(join(tmpdir(), "foundation-coverage-contained-outside-"));
    context.after(() => Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(outside, { force: true, recursive: true }),
    ]));
    await mkdir(join(outside, "evidence"));
    await symlink(outside, join(root, "linked"), "dir");
    await assert.rejects(
      requireContainedRealDirectory(
        join(root, "linked", "evidence"),
        root,
        "coverage evidence parent directory",
      ),
      /must not traverse a symlink/u,
    );
  },
);

test("coverage evidence checks the aggregate raw byte budget using bounded reads", async (context) => {
  const root = await evidenceSet();
  context.after(() => rm(root, { force: true, recursive: true }));
  const raw = join(root, `coverage-evidence-${headSha}-shard-1`, "raw");
  for (let index = 0; index < 17; index += 1) {
    const handle = await open(join(raw, `coverage-${index + 9000}-1-0.json`), "w");
    await handle.truncate(16 * 1024 * 1024);
    await handle.close();
  }
  await assert.rejects(
    validateCoverageEvidenceSet({ headSha, inputDirectory: root }),
    /exceeds its total byte budget/u,
  );
});

test("coverage shard arguments enforce one isolated shard and repository containment", () => {
  assert.deepEqual(parseTestShardArguments(["--shards", "1"]), {
    evidenceDirectory: undefined,
    headSha: undefined,
    ids: ["1"],
  });
  assert.deepEqual(parseTestShardArguments(["--", "--shards", "1"]).ids, ["1"]);
  assert.equal(
    parseCoverageEvidenceArguments(["--", "--input", ".coverage", "--head-sha", headSha])
      .headSha,
    headSha,
  );
  assert.throws(
    () =>
      parseTestShardArguments([
        "--shards",
        "1,2",
        "--coverage-evidence-dir",
        ".coverage/shard",
        "--head-sha",
        headSha,
      ]),
    /exactly one shard/u,
  );
  assert.throws(
    () =>
      parseTestShardArguments([
        "--shards",
        "1",
        "--coverage-evidence-dir",
        "../outside",
        "--head-sha",
        headSha,
      ]),
    /inside the repository/u,
  );
});

test("coverage additions extend Linux evidence without changing the cross-platform shards", () => {
  const ids = ["1", "2", "3", "4"];
  const crossPlatformTests = selectTestShardPaths(testManifest, ids, false);
  const coverageTests = selectTestShardPaths(testManifest, ids, true);
  assert.equal(crossPlatformTests.length, 122);
  assert.equal(
    crossPlatformTests.some((path) => path.startsWith("packages/docs-protocol/tests/")),
    false,
  );
  assert.equal(coverageTests.length, testManifest.testCount);
  assert.equal(
    coverageTests.filter((path) => path.startsWith("packages/docs-protocol/tests/")).length,
    15,
  );
});

test("coverage bootstrap prevents raw evidence from leaking to test subprocesses", async (context) => {
  const bootstrap = pathToFileURL(
    join(repositoryRoot, "scripts", "coverage-process-bootstrap.mjs"),
  ).href;
  const coverageDirectory = await mkdtemp(join(tmpdir(), "foundation-coverage-bootstrap-"));
  context.after(() => rm(coverageDirectory, { force: true, recursive: true }));
  const { stdout: childStdout } = await executeFile(
    process.execPath,
    ["--import", bootstrap, "--eval", "process.stdout.write(String(process.env.NODE_V8_COVERAGE))"],
    {
      env: { ...process.env, NODE_TEST_CONTEXT: "child-v8", NODE_V8_COVERAGE: coverageDirectory },
      encoding: "utf8",
    },
  );
  assert.equal(childStdout, "undefined");

  const parentEnvironment = { ...process.env, NODE_V8_COVERAGE: coverageDirectory };
  delete parentEnvironment.NODE_TEST_CONTEXT;
  const { stdout: parentStdout } = await executeFile(
    process.execPath,
    ["--import", bootstrap, "--eval", "process.stdout.write(String(process.env.NODE_V8_COVERAGE))"],
    { env: parentEnvironment, encoding: "utf8" },
  );
  assert.equal(parentStdout, coverageDirectory);
});

test("a real node:test worker emits raw coverage without instrumenting its grandchild", async (context) => {
  const bootstrap = pathToFileURL(
    join(repositoryRoot, "scripts", "coverage-process-bootstrap.mjs"),
  ).href;
  const fixture = join(repositoryRoot, "tests", "fixtures", "coverage-process-tree.fixture.mjs");
  const coverageDirectory = await mkdtemp(join(tmpdir(), "foundation-coverage-process-tree-"));
  context.after(() => rm(coverageDirectory, { force: true, recursive: true }));
  const environment = { ...process.env, NODE_V8_COVERAGE: coverageDirectory };
  delete environment.NODE_TEST_CONTEXT;
  const { stdout } = await executeFile(
    process.execPath,
    ["--import", bootstrap, "--test", "--test-concurrency=1", fixture],
    { env: environment, encoding: "utf8" },
  );
  const workerPid = /worker-pid:(\d+)/u.exec(stdout)?.[1];
  const grandchildPid = /grandchild-pid:(\d+)/u.exec(stdout)?.[1];
  assert.match(workerPid, /^\d+$/u);
  assert.match(grandchildPid, /^\d+$/u);
  const rawFiles = await readdir(coverageDirectory);
  assert.equal(rawFiles.some((name) => name.startsWith(`coverage-${workerPid}-`)), true);
  assert.equal(rawFiles.some((name) => name.startsWith(`coverage-${grandchildPid}-`)), false);
});

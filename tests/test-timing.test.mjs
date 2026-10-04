import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

import { repositoryRoot } from "../scripts/check-test-manifests.mjs";
import { parseTestShardArguments } from "../scripts/run-test-shard.mjs";

const moduleUrl = (file) => JSON.stringify(pathToFileURL(resolve(repositoryRoot, file)).href);
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;

async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), "EF1-TEST-timing-"));
  try {
    await mkdir(join(root, "architecture/foundation"), { recursive: true });
    return await body(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function contract(root, file, names = ["suite", "required"], exceptions = []) {
  await writeFile(join(root, "architecture/foundation/node-test-execution.json"),
    JSON.stringify({ schemaVersion: 1, required: [{ file, names, kind: "test" }], exceptions }));
}

async function invoke(root, source) {
  await writeFile(join(root, "invoke.mjs"), source);
  const result = spawnSync(process.execPath, [join(root, "invoke.mjs")],
    { cwd: root, env: environment, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  return result;
}

const prefix = "import test, { describe } from 'node:test'; describe('suite', () => {";
const cases = [
  ["pass", "test('required', () => {});", 0],
  ["fail", "test('required', () => { throw Error('fixture failure'); });", 1],
  ["skip", "test('required', { skip: '' }, () => {});", 1],
  ["todo", "test('required', { todo: '' }, () => {});", 1],
  ["omitted", "test('unrelated', () => {});", 1],
  ["expected-failure", "test('required', { expectFailure: true }, () => { throw Error('expected'); });", 1],
];

// Catches timing observers consuming verification events, hiding omissions or
// directives, replacing the mandatory verdict, or propagating a sink error.
for (const [outcome, body, expected] of cases) {
  test(`mandatory ${outcome} verdict is identical with observation off/on/throwing`, async () => fixture(async (root) => {
    await writeFile(join(root, "cases.test.mjs"), `${prefix}${body}});`);
    await contract(root, "cases.test.mjs");
    for (const mode of ["off", "on", "throw"]) {
      const result = await invoke(root, `
import { maybeRunMandatoryNodeTests } from ${moduleUrl("scripts/mandatory-node-test.mjs")};
import { attachTestTiming } from ${moduleUrl("scripts/test-timing.mjs")};
const records = []; let flowing;
const setup = ${JSON.stringify(mode)} === 'off' ? undefined : stream => {
  attachTestTiming(stream, record => { records.push(record); if (${JSON.stringify(mode)} === 'throw') throw Error('sink'); });
  flowing = stream.readableFlowing;
};
const code = await maybeRunMandatoryNodeTests(['cases.test.mjs'], { setup }, ${JSON.stringify(root)});
console.log('TIMING_RESULT ' + JSON.stringify({ records, flowing })); process.exitCode = code;`);
      assert.equal(result.status, expected, `${mode}: ${result.stderr}`);
      const observation = JSON.parse(result.stdout.split("TIMING_RESULT ")[1]);
      if (mode !== "off") {
        assert.notEqual(observation.flowing, true, "observer must not consume the stream");
        assert.ok(observation.records.some((row) => row.kind === "file"));
        if (outcome !== "omitted") {
          const required = observation.records.filter((row) => row.name === "required");
          assert.equal(required.length, 1, "result events must not duplicate completion timings");
          assert.equal(required[0].outcome, outcome);
          assert.ok(required[0].durationMs >= 0);
        }
      }
    }
  }));
}

// A discarded setup promise dispatches the outer file before this barrier is
// ready. Observe Node's enqueue events, independent of test-worker startup time.
test("mandatory delayed async setup finishes before dispatch with timings off/on", async () => fixture(async (root) => {
  await writeFile(join(root, "cases.test.mjs"), `${prefix}${cases[0][1]}});`);
  await contract(root, "cases.test.mjs");
  for (const timingDirectory of [undefined, join(root, "timings")]) {
    const result = await invoke(root, `
import { setTimeout } from 'node:timers/promises';
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
let ready = false; let calls = 0; const dispatched = [];
const code = await runTestShardTests(['cases.test.mjs'], {
  timingDirectory: ${JSON.stringify(timingDirectory) ?? "undefined"},
  runOptions: { setup: async stream => {
    calls++;
    stream.on('test:enqueue', () => dispatched.push(ready));
    await setTimeout(25);
    ready = true;
  } },
}, ${JSON.stringify(root)});
console.log('SETUP_RESULT ' + JSON.stringify({ ready, calls, dispatched })); process.exitCode = code;`);
    assert.equal(result.status, 0, result.stderr);
    const observation = JSON.parse(result.stdout.split("SETUP_RESULT ")[1]);
    assert.equal(observation.calls, 1);
    assert.equal(observation.ready, true);
    assert.ok(observation.dispatched.length > 0, "passing fixture must dispatch");
    assert.ok(observation.dispatched.every(Boolean), "setup must settle before any file or test dispatch");
    if (timingDirectory !== undefined) {
      const rows = (await readFile(join(timingDirectory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(rows.filter((row) => row.name === "required" && row.outcome === "pass").length, 1);
      assert.equal(rows.filter((row) => row.kind === "file").length, 1);
    }
  }
}));

// A rejected setup must retain Node's failure before dispatch. Dropping its
// promise starts the passing fixture and leaves the rejection detached instead.
test("mandatory rejecting async setup fails before dispatch with timings off/on", async () => fixture(async (root) => {
  await writeFile(join(root, "cases.test.mjs"), `${prefix}${cases[0][1]}});`);
  await contract(root, "cases.test.mjs");
  let baseline;
  for (const timingDirectory of [undefined, join(root, "timings")]) {
    const result = await invoke(root, `
import { setTimeout } from 'node:timers/promises';
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
process.exitCode = await runTestShardTests(['cases.test.mjs'], {
  timingDirectory: ${JSON.stringify(timingDirectory) ?? "undefined"},
  runOptions: { setup: async stream => {
    stream.on('test:enqueue', () => console.log('SETUP_DISPATCH'));
    await setTimeout(25);
    throw Error('EF1_ASYNC_SETUP_REJECTION');
  } },
}, ${JSON.stringify(root)});`);
    assert.equal(result.signal, null, result.stderr);
    assert.ok(Number.isInteger(result.status) && result.status > 0, result.stderr);
    assert.match(result.stderr, /EF1_ASYNC_SETUP_REJECTION/u);
    assert.doesNotMatch(result.stdout, /SETUP_DISPATCH/u);
    if (timingDirectory === undefined) { baseline = result.status; }
    else { assert.equal(result.status, baseline, "observer must retain the native setup rejection exit"); }
  }
}));

test("exact applicable skip, todo and omission exceptions retain their verdict", async () => fixture(async (root) => {
  for (const [outcome, body] of cases.filter(([name]) => ["skip", "todo", "omitted"].includes(name))) {
    await writeFile(join(root, "cases.test.mjs"), `${prefix}${body}});`);
    await contract(root, "cases.test.mjs", ["suite", "required"], [{
      file: "cases.test.mjs", names: ["suite", "required"], kind: "test",
      status: outcome === "skip" ? "skipped" : outcome,
      reason: "Reviewed disposable fixture platform exception.", applicability: { platforms: [process.platform] },
    }]);
    for (const observed of [false, true]) {
      const result = await invoke(root, `
import { maybeRunMandatoryNodeTests } from ${moduleUrl("scripts/mandatory-node-test.mjs")};
import { attachTestTiming } from ${moduleUrl("scripts/test-timing.mjs")};
process.exitCode = await maybeRunMandatoryNodeTests(['cases.test.mjs'],
  ${observed ? "{ setup: stream => attachTestTiming(stream, () => { throw Error('sink'); }) }" : "{}"}, ${JSON.stringify(root)});`);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Mandatory Node tests: 1 required identities/u);
    }
  }
}));

// Catches reporter replacement suppressing TAP/failures, and timing destination
// failures turning passing tests red or failing tests green.
for (const [outcome, body] of cases.filter(([name]) => name !== "omitted")) {
  test(`spawn ${outcome} keeps native summaries and verdict when timing writes succeed or fail`, async () => fixture(async (root) => {
    await writeFile(join(root, "cases.test.mjs"), `${prefix}${body}});`);
    await writeFile(join(root, "adopted.test.mjs"), "");
    await contract(root, "adopted.test.mjs");
    const blocked = join(root, "blocked"); await writeFile(blocked, "not a directory");
    const directory = join(root, "timings");
    let baseline;
    for (const timingDirectory of [undefined, directory, blocked]) {
      const result = await invoke(root, `
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
process.exitCode = await runTestShardTests(['cases.test.mjs'],
  { timingDirectory: ${JSON.stringify(timingDirectory) ?? "undefined"} }, ${JSON.stringify(root)});`);
      const verdict = outcome === "fail" ? 1 : 0;
      assert.equal(result.status, verdict, result.stderr);
      assert.match(result.stdout, /TAP version 13/u);
      const summary = result.stdout.match(/^# (?:tests|suites|pass|fail|cancelled|skipped|todo) \d+$/gmu);
      assert.ok(summary?.length);
      if (timingDirectory === undefined) { baseline = summary; }
      else { assert.deepEqual(summary, baseline); }
      if (timingDirectory === blocked) { assert.match(result.stderr, /Test timing is advisory/u); }
      if (timingDirectory === directory) {
        const rows = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(rows.filter((row) => row.kind === "file").length, 1);
        assert.equal(rows.find((row) => row.name === "required").outcome, outcome);
      }
    }
  }));
}

test("mandatory timing write failures preserve pass and fail verdicts", async () => fixture(async (root) => {
  const blocked = join(root, "blocked"); await writeFile(blocked, "not a directory");
  await contract(root, "cases.test.mjs");
  for (const [, body, expected] of cases.slice(0, 2)) {
    await writeFile(join(root, "cases.test.mjs"), `${prefix}${body}});`);
    const result = await invoke(root, `
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
process.exitCode = await runTestShardTests(['cases.test.mjs'],
  { timingDirectory: ${JSON.stringify(blocked)} }, ${JSON.stringify(root)});`);
    assert.equal(result.status, expected, result.stderr);
    assert.match(result.stderr, /Test timing is advisory/u);
  }
}));

test("timing replaces a leaf hardlink without corrupting coverage evidence", async () => fixture(async (root) => {
  await writeFile(join(root, "cases.test.mjs"), "import test from 'node:test'; test('required', () => {});");
  await contract(root, "cases.test.mjs", ["required"]);
  const evidenceDirectory = join(root, ".coverage-evidence");
  const rawDirectory = join(evidenceDirectory, "raw");
  const timingDirectory = join(root, "timings");
  await mkdir(rawDirectory, { recursive: true });
  await mkdir(timingDirectory);
  const protectedFile = join(rawDirectory, "protected.json");
  const sentinel = Buffer.from("SENTINEL");
  await writeFile(protectedFile, sentinel);
  await link(protectedFile, join(timingDirectory, "events.jsonl"));
  const baseline = await invoke(root, `
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
process.exitCode = await runTestShardTests(['cases.test.mjs'], {}, ${JSON.stringify(root)});`);
  const result = await invoke(root, `
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
process.exitCode = await runTestShardTests(['cases.test.mjs'],
  ${JSON.stringify({ timingDirectory, evidenceDirectory })}, ${JSON.stringify(root)});`);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(result.status, baseline.status, result.stderr);
  assert.match(result.stdout, /Mandatory Node tests: 1 required identities/u);
  assert.deepEqual(await readFile(protectedFile), sentinel, "timing must not truncate linked raw coverage");
  const rows = (await readFile(join(timingDirectory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter((row) => row.kind === "test" && row.name === "required" && row.outcome === "pass").length, 1);
  assert.equal(rows.filter((row) => row.kind === "file" && row.outcome === "pass").length, 1);
  assert.deepEqual(await readdir(timingDirectory), ["events.jsonl"], "owned temporary file must be cleaned up");
}));

test("timing rechecks coverage containment after async setup swaps the directory", async () => fixture(async (root) => {
  await writeFile(join(root, "cases.test.mjs"), "import test from 'node:test'; test('required', () => {});");
  await contract(root, "cases.test.mjs", ["required"]);
  const evidenceDirectory = join(root, ".coverage-evidence");
  const rawDirectory = join(evidenceDirectory, "raw");
  const timingDirectory = join(root, "timings");
  await mkdir(rawDirectory, { recursive: true });
  await mkdir(timingDirectory);
  const protectedFile = join(rawDirectory, "events.jsonl");
  const sentinel = Buffer.from("SENTINEL");
  await writeFile(protectedFile, sentinel);
  const baseline = await invoke(root, `
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
process.exitCode = await runTestShardTests(['cases.test.mjs'], {}, ${JSON.stringify(root)});`);
  const result = await invoke(root, `
import { rm, symlink } from 'node:fs/promises';
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
process.exitCode = await runTestShardTests(['cases.test.mjs'], {
  ...${JSON.stringify({ timingDirectory, evidenceDirectory })},
  runOptions: { setup: async () => {
    await rm(${JSON.stringify(timingDirectory)}, { recursive: true });
    await symlink(${JSON.stringify(rawDirectory)}, ${JSON.stringify(timingDirectory)},
      process.platform === 'win32' ? 'junction' : 'dir');
  } },
}, ${JSON.stringify(root)});`);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(result.status, baseline.status, result.stderr);
  assert.match(result.stdout, /Mandatory Node tests: 1 required identities/u);
  assert.deepEqual(await readFile(protectedFile), sentinel, "post-validation alias must not change raw coverage");
  assert.match(result.stderr, /Test timing is advisory: .*outside the coverage/u);
  assert.deepEqual(await readdir(rawDirectory), ["events.jsonl"], "no timing files may be created in coverage");
}));

test("timing rejects coverage descendants, equality and directory aliases", async () => {
  for (const path of [".coverage-evidence", ".coverage-evidence/shard-1/timing", "custom-coverage", "custom-coverage/timing"]) {
    assert.throws(() => parseTestShardArguments(["--shards", "1", "--coverage-evidence-dir", "custom-coverage",
      "--head-sha", "a".repeat(40), "--timing-output", path]), /outside the coverage/u);
  }
  await fixture(async (root) => {
    await mkdir(join(root, ".coverage-evidence"));
    const alias = join(root, "alias");
    await symlink(join(root, ".coverage-evidence"), alias, process.platform === "win32" ? "junction" : "dir");
    const result = await invoke(root, `
import { runTestShardTests } from ${moduleUrl("scripts/run-test-shard.mjs")};
await runTestShardTests([], { timingDirectory: ${JSON.stringify(join(alias, "timings"))} }, ${JSON.stringify(root)});`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the coverage/u);
  });
});

test("CI retains registry and package obligations and isolated advisory timing uploads", async () => {
  const ci = parse(await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
  assert.deepEqual(ci.jobs["linux-registry"].steps.filter((step) => step.run).map((step) => step.run),
    ["pnpm install --frozen-lockfile", "pnpm registry-install-e2e"]);
  assert.ok(ci.jobs["linux-package"].steps.some((step) => step.run === "pnpm package:check:built"));
  const scripts = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")).scripts;
  assert.equal(scripts["registry-install-e2e"], "pnpm build && pnpm package:qualification:built");
  assert.equal(scripts["package:qualification:built"], "node scripts/qualify-package-artifacts.mts");
  assert.ok(ci.jobs["macos-package"].steps.some((step) => step.run === 'pnpm package:qualification:built "$QUALIFICATION_PROFILE"'));
  assert.equal(scripts["package:check:built"], "node scripts/prepare-package.mjs && node scripts/check-publishable-packages.mjs && node scripts/pack-test.mjs");
  const producers = ci.jobs["linux-tests"];
  for (const key of ["first", "second"]) {
    const identity = "${{ matrix.pair." + key + " }}";
    const upload = producers.steps.find(step => step.name === `Upload ${key} advisory test timings`);
    assert.equal(upload.if, "${{ always() }}");
    assert.equal(upload.with.path, "${{ runner.temp }}/producer-" + identity + "/test-timing/linux-test-" + identity);
    assert.equal(upload.with.name, "test-timing-${{ github.sha }}-linux-test-" + identity);
    assert.equal(upload.with["if-no-files-found"], "warn");
    assert.equal(upload.with["retention-days"], 14);
    assert.equal(upload["continue-on-error"], true);
  }
  const paths = new Set();
  for (const jobId of ["windows-test-a", "windows-test-b", "windows-test-c", "windows-test-d", "windows-test-e"]) {
    const job = ci.jobs[jobId];
    const run = job.steps.find((step) => jobId === "windows-test-a"
      ? step.name === "Run isolated Windows test partition"
      : step.run?.includes("test:shard:built"));
    assert.match(run.run, /--timing-output/u);
    if (jobId.startsWith("windows-test-")) { assert.match(run.run, /--windows-lane [abcde] /u); }
    const upload = job.steps.find((step) => step.name === "Upload advisory test timings");
    assert.equal(upload.if, "${{ always() }}");
    assert.equal(upload.with["if-no-files-found"], "warn");
    assert.equal(upload.with["retention-days"], 14);
    assert.equal(upload["continue-on-error"], true);
    assert.equal(paths.has(upload.with.path), false);
    paths.add(upload.with.path);
  }
});

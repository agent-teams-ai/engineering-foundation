import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executeFile = promisify(execFile);

// A child-process failure must fail the pair after its independent sibling has
// finished, while retaining each producer's status and private environment.
if (process.platform === "linux") {
  for (const phase of ["build", "test"]) {
    test(`paired Linux ${phase} drains siblings and isolates producer state`, async context => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-pair-test-")));
      context.after(() => rm(root, { recursive: true, force: true }));
      const temporary = join(root, "temporary");
      const bin = join(root, "bin");
      const output = join(root, "output");
      const log = join(root, "commands.jsonl");
      await Promise.all(["producer-a", "producer-b", "temporary", "bin"].map(name => mkdir(join(root, name))));
      await writeFile(join(bin, "pnpm"), `#!${process.execPath}\n${String.raw`
const fs = require("node:fs");
const record = { cwd: process.cwd(), args: process.argv.slice(2),
  temporary: process.env.RUNNER_TEMP, tmpdir: process.env.TMPDIR,
  tools: process.env.MANAGED_TEST_TOOLS_ROOT, managed: process.env.MANAGED_TEST_ROOT,
  node26: process.env.MANAGED_TEST_NODE26_SOURCE };
fs.appendFileSync(process.env.PAIR_TEST_LOG, JSON.stringify(record) + "\n");
if (process.cwd().endsWith("producer-a")) process.exit(7);
setTimeout(() => {
  fs.writeFileSync(process.env.RUNNER_TEMP + "/sibling-finished", "done");
}, 80);
`}`, { mode: 0o755 });
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: "a".repeat(40),
        RUNNER_TEMP: temporary, GITHUB_OUTPUT: output, PAIR_TEST_LOG: log,
        MANAGED_TEST_TOOLS_ROOT: "/declared-tools", MANAGED_TEST_ROOT: "/declared-managed",
        MANAGED_TEST_NODE26_SOURCE: "/declared-node26" };
      const helper = join(repositoryRoot, "scripts", "run-ci-test-pair.mts");
      await assert.rejects(executeFile(process.execPath, [helper, phase, "3", "4"], { cwd: root, env }),
        error => error.code === 1 && /producer 3.*exited 7/u.test(error.stderr));
      assert.equal(await readFile(output, "utf8"), "first-status=7\nsecond-status=0\n");
      assert.equal(await readFile(join(temporary, "producer-4", "sibling-finished"), "utf8"), "done");
      const records = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.filter(record => record.cwd === join(root, "producer-a")).length, 1);
      assert.equal(records.filter(record => record.cwd === join(root, "producer-b")).length, phase === "build" ? 3 : 1);
      for (const record of records) {
        const first = record.cwd === join(root, "producer-a");
        assert.equal(record.temporary, join(temporary, first ? "producer-3" : "producer-4"));
        assert.equal(record.tmpdir, record.temporary);
        assert.equal(record.tools, first ? undefined : "/declared-tools");
        assert.equal(record.managed, first ? undefined : "/declared-managed");
        assert.equal(record.node26, first ? undefined : "/declared-node26");
        if (phase === "test") {
          assert.equal(record.args[record.args.indexOf("--shards") + 1], first ? "3" : "4");
          assert.equal(record.args[record.args.indexOf("--head-sha") + 1], "a".repeat(40));
        }
      }
      const before = await readFile(log, "utf8");
      await assert.rejects(executeFile(process.execPath, [helper, phase, "3", "5"], { cwd: root, env }), /Usage/u);
      assert.equal(await readFile(log, "utf8"), before, "invalid pair must not launch a producer");
    });
  }
}

test("partitioned coverage is the fail-closed blocking coverage authority", async () => {
  const ci = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  );
  const codeql = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "codeql.yml"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "tests", "manifests", "coverage.v1.json"), "utf8"),
  );
  assert.deepEqual(manifest.evidenceThresholds, { lines: 70, branches: 77, functions: 78 });
  const coverage = ci.jobs["linux-coverage"];
  assert.equal(ci.jobs["linux-coverage-evidence-advisory"], undefined);
  assert.equal(coverage.steps.every((step) => step["continue-on-error"] === undefined), true);
  assert.ok(ci.jobs.check.needs.includes("linux-coverage"));
  assert.equal(JSON.stringify(ci).includes("FOUNDATION_PARTITIONED_COVERAGE"), false);
  const readyPullRequestCondition =
    "${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}";
  assert.deepEqual(ci.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ]);
  assert.deepEqual(codeql.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ]);
  assert.equal(ci.jobs["dependency-review"].if, undefined);
  assert.equal(
    ci.jobs["draft-fast"].if,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.draft == true }}",
  );
  assert.equal(ci.jobs["draft-fast"].steps.at(-1).run, "pnpm check:changed");
  assert.equal(codeql.jobs.analyze.if, readyPullRequestCondition);
  for (const [jobId, job] of Object.entries(ci.jobs)) {
    if (jobId === "dependency-review" || jobId === "shadow-classifier") {
      continue;
    }
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.ok(needs.includes("dependency-review"), `${jobId} bypasses ready gating`);
    let expectedCondition = readyPullRequestCondition;
    if (jobId === "draft-fast") {
      expectedCondition =
        "${{ github.event_name == 'pull_request' && github.event.pull_request.draft == true }}";

    } else if (["check", "windows-check", "macos-qualification"].includes(jobId)) {
      expectedCondition =
        "${{ always() && (github.event_name != 'pull_request' || github.event.pull_request.draft == false) }}";
    }
    assert.equal(
      job.if,
      expectedCondition,
      `${jobId} must skip heavy work for draft pull requests`,
    );
  }
  assert.deepEqual(coverage.needs, [
    "dependency-review",
    "linux-tests",
  ]);
  const download = coverage.steps.find(({ name }) => name === "Download exact-head shard evidence");
  assert.match(download.uses, /^actions\/download-artifact@[a-f0-9]{40}$/u);
  assert.equal(download.with.pattern, "coverage-evidence-${{ github.sha }}-shard-*");
  assert.equal(download.with["merge-multiple"], false);
  assert.match(coverage.steps.at(-1).run, /--head-sha "\$\{\{ github\.sha \}\}"/u);
  assert.equal(coverage.steps.some(({ run }) => /test:coverage:built/u.test(run ?? "")), false);

  const producer = ci.jobs["linux-tests"];
  assert.equal(producer.strategy["fail-fast"], false);
  assert.equal(producer.strategy["max-parallel"], undefined);
  const pairs = producer.strategy.matrix.pair;
  assert.deepEqual(pairs.map(pair => [pair.first, pair.second]),
    [["1", "2"], ["3", "4"], ["5", "6"], ["7", "8"]]);
  assert.deepEqual(pairs.flatMap(pair => [pair.first, pair.second]).toSorted(),
    ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(producer.name, "linux-tests-${{ matrix.pair.first }}-${{ matrix.pair.second }}");
  assert.equal(producer["continue-on-error"], undefined);
  assert.equal(producer.env.NODE_DISABLE_COMPILE_CACHE, "1");
  assert.equal(producer.env.FIRST_SHARD, "${{ matrix.pair.first }}");
  assert.equal(producer.env.SECOND_SHARD, "${{ matrix.pair.second }}");
  const checkouts = producer.steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkouts.map(step => step.with.path), ["producer-a", "producer-b"]);
  for (const checkout of checkouts) {
    assert.equal(checkout.with["fetch-depth"], 0);
    assert.equal(checkout.with["persist-credentials"], false);
  }
  const setup = producer.steps.find(step => step.uses?.startsWith("pnpm/setup@"));
  assert.equal(setup.with["working-directory"], "producer-a");
  assert.equal(setup.with.install, false);
  const build = producer.steps.find(step => step.name === "Build both isolated producers");
  assert.equal(build.run, 'node producer-a/scripts/run-ci-test-pair.mts build "$FIRST_SHARD" "$SECOND_SHARD"');
  const run = producer.steps.find(step => step.id === "test-pair");
  assert.equal(run.run, 'node producer-a/scripts/run-ci-test-pair.mts test "$FIRST_SHARD" "$SECOND_SHARD"');
  assert.equal(run["continue-on-error"], undefined);
  for (const [key, root] of [["first", "producer-a"], ["second", "producer-b"]]) {
    const identity = "${{ matrix.pair." + key + " }}";
    const upload = producer.steps.find(step => step.name === `Upload ${key} raw coverage evidence`);
    assert.match(upload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
    assert.equal(upload["continue-on-error"], undefined);
    assert.equal(upload.if, "${{ always() && steps.test-pair.outputs." + key + "-status == '0' }}");
    assert.equal(upload.with.name, "coverage-evidence-${{ github.sha }}-shard-" + identity);
    assert.equal(upload.with.path, root + "/.coverage-evidence/shard-" + identity);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["include-hidden-files"], true);
    assert.equal(upload.with.overwrite, true);
  }
  const managed = producer.steps.filter(step => step.name?.includes("pinned"));
  assert.equal(managed.length, 2);
  for (const step of managed) { assert.equal(step.if, "${{ matrix.pair.second == '4' }}"); }
  const provision = managed.find(step => step.run?.includes("provision-managed-test-tools"));
  assert.equal(provision["working-directory"], "producer-b");
  assert.equal(provision.env.RUNNER_TEMP, "${{ runner.temp }}/producer-4");
  const node26 = producer.steps.find(step => step.with?.["node-version"] === "26.10.0");
  assert.equal(node26.if, "${{ matrix.pair.second == '4' }}");
  const node24 = producer.steps.find(step => step.with?.["node-version-file"]);
  assert.equal(node24.with["node-version-file"], "producer-a/.node-version");
  assert.equal(node24.with["cache-dependency-path"], "producer-a/pnpm-lock.yaml");
  assert.ok(producer.steps.indexOf(node26) < producer.steps.indexOf(node24));


});

test("Ready PR feedback checks the committed delta independently of full qualification", async () => {
  const ci = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  );
  const preliminary = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "pr-feedback.yml"), "utf8"),
  );
  assert.notEqual(preliminary.name, ci.name, "Feedback must not change the full CI run conclusion");
  assert.equal(ci.jobs["pr-feedback"], undefined);
  assert.deepEqual(preliminary.permissions, { contents: "read" });
  assert.deepEqual(preliminary.on.pull_request.types, ci.on.pull_request.types);
  const feedback = preliminary.jobs["pr-feedback"];
  assert.ok(feedback, "Ready pull requests need a preliminary feedback lane");
  assert.equal(feedback.if,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.draft == false }}");
  const security = preliminary.jobs["dependency-review"];
  assert.ok(security, "Feedback needs its own declared blocking Dependency Review job");
  assert.equal(security.if, undefined);
  assert.equal(security["continue-on-error"], undefined);
  assert.equal(feedback.needs, "dependency-review");
  const review = security.steps.find(({ uses }) =>
    uses?.startsWith("actions/dependency-review-action@"));
  const declaredReview = ci.jobs["dependency-review"].steps.find(({ uses }) =>
    uses?.startsWith("actions/dependency-review-action@"));
  assert.deepEqual(review, declaredReview,
    "Feedback Dependency Review must preserve the declared blocking security semantics");
  const installIndex = feedback.steps.findIndex(({ run }) =>
    run === "pnpm install --frozen-lockfile --ignore-scripts");
  assert.ok(installIndex > 0, "Feedback must install pinned dependencies after checkout");
  assert.equal(feedback["timeout-minutes"], 10);
  const checkout = feedback.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["fetch-depth"], 0, "PR base and merge-base history must be available");
  assert.equal(checkout.with["persist-credentials"], false);
  const changed = feedback.steps.find(({ name }) => name === "Check the complete pull-request delta");
  assert.deepEqual(changed.env, {
    FOUNDATION_PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
  });
  assert.equal(changed.run, 'pnpm check:changed --base "$FOUNDATION_PR_BASE_SHA"');
  assert.equal(changed["continue-on-error"], undefined);
  for (const [jobId, job] of Object.entries(ci.jobs)) {
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.equal(needs.includes("pr-feedback"), false,
      `${jobId} must not make preliminary feedback a full-qualification prerequisite`);
  }
  for (const requiredJob of ["check", "windows-check", "macos-qualification"]) {
    assert.ok(ci.jobs[requiredJob], `${requiredJob} remains a full qualification authority`);
  }
});

// Enabling cache in raw producers can silently reduce precise V8 coverage.
test("CI cannot enable an unqualified compile cache and raw coverage disables it", async () => {
  const ci = parseYaml(await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
  const enabled = Object.entries(ci.jobs).flatMap(([id, job]) =>
    job.steps.flatMap(step => step.env?.NODE_COMPILE_CACHE === undefined ? [] : [{ id, step }]));
  assert.deepEqual(enabled, []);
  for (const [id, job] of Object.entries(ci.jobs)) {
    assert.equal(job.env?.NODE_COMPILE_CACHE, undefined, `${id} cannot enable cache for unqualified suites`);
  }
});

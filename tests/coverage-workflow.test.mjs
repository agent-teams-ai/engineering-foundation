import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
  assert.deepEqual(producer.strategy, { "fail-fast": false, "max-parallel": 5,
    matrix: { shard: ["1", "2", "3", "4", "5", "6", "7", "8"] } });
  assert.equal(producer.name, "linux-test-${{ matrix.shard }}");
  assert.equal(producer["continue-on-error"], undefined);
  assert.equal(producer.env.NODE_DISABLE_COMPILE_CACHE, "1");
  assert.equal(producer.env.TEST_SHARD, "${{ matrix.shard }}");
  const run = producer.steps.find(({ name }) => name === "Run isolated test shard");
  assert.match(run.run, /--shards "\$TEST_SHARD" /u);
  assert.match(run.run, /--coverage-evidence-dir "\.coverage-evidence\/shard-\$TEST_SHARD"/u);
  const upload = producer.steps.find(({ name }) => name === "Upload raw coverage evidence");
  assert.match(upload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
  assert.equal(upload["continue-on-error"], undefined);
  assert.equal(upload.with.name, "coverage-evidence-${{ github.sha }}-shard-${{ matrix.shard }}");
  assert.equal(upload.with.path, ".coverage-evidence/shard-${{ matrix.shard }}");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["include-hidden-files"], true);
  assert.equal(upload.with.overwrite, true);
  const managed = producer.steps.filter(step => step.name?.includes("pinned"));
  assert.equal(managed.length, 2);
  for (const step of managed) { assert.equal(step.if, "${{ matrix.shard == '4' }}"); }
  const node26 = producer.steps.find(step => step.with?.["node-version"] === "26.10.0");
  assert.equal(node26.if, "${{ matrix.shard == '4' }}");

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

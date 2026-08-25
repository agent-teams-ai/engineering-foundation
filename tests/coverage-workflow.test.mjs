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
    } else if (jobId === "check" || jobId === "windows-check") {
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
    "linux-test-1",
    "linux-test-2",
    "linux-test-3",
    "linux-test-4",
  ]);
  const download = coverage.steps.find(({ name }) => name === "Download exact-head shard evidence");
  assert.match(download.uses, /^actions\/download-artifact@[a-f0-9]{40}$/u);
  assert.equal(download.with.pattern, "coverage-evidence-${{ github.sha }}-shard-*");
  assert.equal(download.with["merge-multiple"], false);
  assert.match(coverage.steps.at(-1).run, /--head-sha "\$\{\{ github\.sha \}\}"/u);
  assert.equal(coverage.steps.some(({ run }) => /test:coverage:built/u.test(run ?? "")), false);

  for (const shardId of ["1", "2", "3", "4"]) {
    const job = ci.jobs[`linux-test-${shardId}`];
    const run = job.steps.find(({ name }) => name === "Run isolated test shard");
    const upload = job.steps.find(({ name }) => name === "Upload raw coverage evidence");
    assert.match(run.run, new RegExp(`--shards ${shardId} `, "u"));
    assert.match(
      run.run,
      new RegExp(`--coverage-evidence-dir \\.coverage-evidence/shard-${shardId}`, "u"),
    );
    assert.match(upload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
    assert.equal(upload["continue-on-error"], undefined);
    assert.equal(upload.with.name, `coverage-evidence-${"${{ github.sha }}"}-shard-${shardId}`);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["include-hidden-files"], true);
    assert.equal(upload.with.overwrite, true);
  }
});

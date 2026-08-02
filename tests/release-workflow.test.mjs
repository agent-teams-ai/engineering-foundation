import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function workflow(name) {
  return parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", name), "utf8"),
  );
}

test("release pipeline runs an exact App-first review", async () => {
  const release = await workflow("release.yml");
  const review = await workflow("reviewrouter-codex.yml");
  const releaseReview = await workflow("reviewrouter-release.yml");
  const releaseJob = release.jobs.release;
  const attestation = release.jobs["attest-release-pr"].steps.find(
    ({ name }) => name === "Dispatch and attest release pull request checks",
  );

  assert.match(releaseJob.outputs.pullRequestHeadSha, /release-pr/u);
  assert.match(
    releaseJob.steps.find(({ id }) => id === "release-pr").run,
    /printf 'head_sha=%s\\n'/u,
  );
  assert.equal(releaseReview.on.workflow_dispatch.inputs.pr_number.required, true);
  assert.equal(releaseReview.on.workflow_dispatch.inputs.review_head_sha.required, true);
  assert.match(releaseReview.jobs["codex-review"].uses, /reviewrouter-t0-reusable\.yml@/u);
  assert.equal(releaseReview.jobs["codex-review"].with.workflow_schema_version, 2);
  assert.equal(
    releaseReview.jobs["codex-review"].with.static_runtime_env_json,
    '{"SKIP_BOTS":"false"}',
  );
  assert.match(releaseReview.jobs["codex-review"].with.pr_number, /inputs\.pr_number/u);
  assert.match(
    releaseReview.jobs["codex-review"].with.review_head_sha,
    /inputs\.review_head_sha/u,
  );
  assert.match(
    attestation.run,
    /gh workflow run reviewrouter-release\.yml[\s\S]*-f pr_number=[\s\S]*-f review_head_sha=/u,
  );
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-codex\.yml/u);
  assert.doesNotMatch(attestation.run, /\.context == "ReviewRouter"/u);
  assert.doesNotMatch(attestation.run, /post_status "ReviewRouter"/u);
  assert.match(attestation.run, /for context in "\$\{ci_contexts\[@\]\}"/u);
  assert.equal(
    release.jobs["attest-release-pr"].permissions.actions,
    "write",
  );
  assert.equal(review.on.workflow_dispatch, undefined);
  assert.equal(review.jobs["codex-review"].with.workflow_schema_version, 2);
  assert.match(review.jobs["codex-review"].if, /user\.type != 'Bot'/u);
});

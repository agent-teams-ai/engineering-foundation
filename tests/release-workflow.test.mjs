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
  const releaseJob = release.jobs.release;
  const releaseReview = release.jobs["review-release-pr"];
  const attestation = release.jobs["attest-release-pr"].steps.find(
    ({ name }) => name === "Dispatch and attest release pull request checks",
  );

  assert.match(releaseJob.outputs.pullRequestHeadSha, /release-pr/u);
  assert.match(
    releaseJob.steps.find(({ id }) => id === "release-pr").run,
    /printf 'head_sha=%s\\n'/u,
  );
  assert.match(releaseReview.uses, /reviewrouter-t0-reusable\.yml@/u);
  assert.equal(releaseReview.with.workflow_schema_version, 2);
  assert.equal(releaseReview.with.static_runtime_env_json, '{"SKIP_BOTS":"false"}');
  assert.match(releaseReview.with.pr_number, /pullRequestNumber/u);
  assert.match(releaseReview.with.review_head_sha, /pullRequestHeadSha/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-codex\.yml/u);
  assert.match(attestation.run, /\.context == "ReviewRouter"/u);
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

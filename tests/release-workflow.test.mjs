import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  releasePullRequestContentViolations,
  releasePullRequestFileViolations,
} from "../scripts/check-release-pr-files.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function workflow(name) {
  return parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", name), "utf8"),
  );
}

test("release pipeline runs an exact App-first review", async () => {
  const release = await workflow("release.yml");
  const review = await workflow("reviewrouter-codex.yml");
  const reviewGate = await workflow("review-gate.yml");
  const releaseJob = release.jobs.release;
  const attestation = release.jobs["attest-release-pr"].steps.find(
    ({ name }) => name === "Dispatch and attest release pull request checks",
  );

  assert.match(releaseJob.outputs.pullRequestHeadSha, /release-pr/u);
  assert.match(
    releaseJob.steps.find(({ id }) => id === "release-pr").run,
    /printf 'head_sha=%s\\n'/u,
  );
  assert.deepEqual(reviewGate.on.workflow_run.workflows, ["ReviewRouter Codex OAuth"]);
  assert.equal(reviewGate.jobs["review-gate"].permissions.actions, "read");
  assert.equal(reviewGate.jobs["review-gate"].permissions["pull-requests"], "read");
  assert.equal(reviewGate.jobs["review-gate"].permissions.statuses, "write");
  assert.match(reviewGate.jobs["review-gate"].steps[0].run, /-f context="ReviewGate"/u);
  assert.match(reviewGate.jobs["review-gate"].steps[0].run, /\.context == "ReviewRouter"/u);
  assert.match(reviewGate.jobs["review-gate"].steps[0].run, /\.creator\.id == \$app_bot_id/u);
  assert.match(reviewGate.jobs["review-gate"].steps[0].run, /\.creator\.type == "Bot"/u);
  assert.equal(
    reviewGate.jobs["review-gate"].steps[0].env.REVIEWROUTER_APP_BOT_ID,
    "281702430",
  );
  assert.match(reviewGate.jobs["review-gate"].steps[0].run, /reviewrouter-codex\.yml/u);
  assert.match(attestation.run, /node scripts\/check-release-pr-files\.mjs/u);
  assert.match(attestation.run, /--base "\$\{base_sha\}" --head "\$\{head_sha\}"/u);
  assert.match(attestation.run, /post_status "\$\{release_gate_context\}" success/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-codex\.yml/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-release\.yml/u);
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

test("release ReviewGate permits only version and prepend-only changelog changes", () => {
  const evidence = {
    baseManifest: { name: "@agent-teams/engineering-foundation", version: "0.4.1" },
    headManifest: { name: "@agent-teams/engineering-foundation", version: "0.5.0" },
    baseChangelog: "# Changelog\n\n## 0.4.1\n",
    headChangelog: "## 0.5.0\n\nNew capability.\n\n# Changelog\n\n## 0.4.1\n",
  };

  assert.deepEqual(releasePullRequestContentViolations(evidence), []);
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, scripts: { prepublishOnly: "steal-secrets" } },
    })[0],
    /only package\.json version/u,
  );
  assert.match(
    releasePullRequestContentViolations({ ...evidence, headChangelog: "rewritten" })[0],
    /only prepend/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, version: "0.4.0" },
    })[0],
    /valid new version/u,
  );
});

test("release ReviewGate accepts only normalized Changesets output", () => {
  const validFiles = [
    { filename: ".changeset/portable-agent-workflow.md", status: "removed" },
    { filename: "architecture/public-api/engineering-foundation.json", status: "modified" },
    { filename: "packages/engineering-foundation/CHANGELOG.md", status: "modified" },
    { filename: "packages/engineering-foundation/package.json", status: "modified" },
  ];

  assert.deepEqual(releasePullRequestFileViolations(validFiles), []);
  assert.match(
    releasePullRequestFileViolations([
      ...validFiles,
      { filename: "packages/engineering-foundation/src/backdoor.ts", status: "added" },
    ])[0],
    /forbidden change/u,
  );
  assert.match(
    releasePullRequestFileViolations(
      validFiles.filter(({ filename }) => !filename.endsWith("package.json")),
    )[0],
    /must modify/u,
  );
});

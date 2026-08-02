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

test("release attestation relies on the canonical client-triggered review", async () => {
  const release = await workflow("release.yml");
  const review = await workflow("reviewrouter-codex.yml");
  const attestation = release.jobs["attest-release-pr"].steps.find(
    ({ name }) => name === "Dispatch and attest release pull request checks",
  );

  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-codex\.yml/u);
  assert.match(attestation.run, /\.context == "ReviewRouter"/u);
  assert.equal(
    review.on.pull_request.types.includes("ready_for_review"),
    true,
  );
  assert.equal(review.on.workflow_dispatch, undefined);
  assert.equal(review.jobs["codex-review"].with.workflow_schema_version, 2);
});

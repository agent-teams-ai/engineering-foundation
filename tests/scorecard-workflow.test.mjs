import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse as parseYaml } from "yaml";

test("OpenSSF Scorecard is advisory, least-privileged, and cannot consume fork artifacts", async () => {
  const source = await readFile(new URL("../.github/workflows/scorecard.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(Object.keys(workflow.on).toSorted(), ["schedule", "workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.scorecard.permissions, {
    contents: "read",
    "security-events": "write",
  });
  assert.equal(workflow.jobs.scorecard.if, "${{ github.repository == 'agent-teams-ai/engineering-foundation' }}");
  assert.doesNotMatch(source, /pull_request|workflow_run|download-artifact|id-token|contents:\s*write/u);
  assert.match(source, /ossf\/scorecard-action@[a-f0-9]{40}/u);
  assert.match(source, /github\/codeql-action\/upload-sarif@[a-f0-9]{40}/u);
  assert.equal(workflow.jobs.scorecard.steps[1].with.publish_results, false);
  assert.equal(workflow.jobs.scorecard.steps[1].with.results_format, "sarif");
});

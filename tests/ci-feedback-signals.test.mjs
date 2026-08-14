import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  buildCiSignalArtifact,
  renderCiSignalSummary,
  sourceRelevance,
} from "../scripts/ci-feedback.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sourceRun() {
  return {
    id: 123,
    run_attempt: 2,
    head_sha: "a".repeat(40),
    head_repository: { full_name: "example/fork" },
    repository: { full_name: "example/foundation" },
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    conclusion: "success",
    head_branch: "feature",
    created_at: "2026-08-13T10:00:00.000Z",
    run_started_at: "2026-08-13T10:01:00.000Z",
    updated_at: "2026-08-13T10:10:00.000Z",
    html_url: "https://github.com/example/foundation/actions/runs/123",
  };
}

function job(id, name, seconds) {
  return {
    id,
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-13T10:00:00.000Z",
    completed_at: new Date(Date.parse("2026-08-13T10:00:00.000Z") + seconds * 1_000).toISOString(),
    labels: ["ubuntu-24.04"],
  };
}

test("CI signal artifact is source-bound, deterministic, and advisory", () => {
  const artifact = buildCiSignalArtifact({
    sourceRun: sourceRun(),
    jobs: [job(2, "slow", 120), job(1, "fast", 30)],
    relevance: { status: "current", pullRequest: 7 },
  });
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.advisory, true);
  assert.equal(artifact.source.runAttempt, 2);
  assert.equal(artifact.source.wallMilliseconds, 540_000);
  assert.deepEqual(artifact.jobs.map(({ name }) => name), ["fast", "slow"]);
  assert.match(artifact.topologyFingerprint, /^sha256:[a-f0-9]{64}$/u);
  const summary = renderCiSignalSummary(artifact);
  assert.ok(summary.indexOf("slow") < summary.indexOf("fast"));
  assert.match(summary, /advisory and never block/u);
  const escaped = renderCiSignalSummary(buildCiSignalArtifact({
    sourceRun: sourceRun(),
    jobs: [job(1, "table|row\nspoof", 1)],
    relevance: { status: "current", pullRequest: 7 },
  }));
  assert.match(escaped, /table\\\|row spoof/u);
});

test("CI relevance fallback binds a pull request to the exact head repository and SHA", async () => {
  const requests = [];
  const request = async (path) => {
    requests.push(path);
    if (path.includes("/commits/")) {
      return [
        { number: 7, head: { sha: "a".repeat(40), repo: { full_name: "other/fork" } } },
        { number: 8, head: { sha: "a".repeat(40), repo: { full_name: "example/fork" } } },
      ];
    }
    return {
      number: 8,
      state: "open",
      head: { sha: "a".repeat(40), repo: { full_name: "example/fork" } },
    };
  };
  assert.deepEqual(await sourceRelevance({ ...sourceRun(), pull_requests: [] }, "token", "https://api.github.test", request), {
    status: "current",
    pullRequest: 8,
  });
  assert.deepEqual(requests, [
    `/repos/example/foundation/commits/${"a".repeat(40)}/pulls?per_page=10`,
    "/repos/example/foundation/pulls/8",
  ]);
});

test("CI signal artifact rejects ambiguous job identity and invalid chronology", () => {
  assert.throws(
    () => buildCiSignalArtifact({
      sourceRun: sourceRun(),
      jobs: [job(1, "same", 1), job(2, "same", 2)],
      relevance: { status: "current", pullRequest: 7 },
    }),
    /duplicate job names/u,
  );
  const invalid = job(1, "invalid", 1);
  invalid.completed_at = "2026-08-13T09:59:00.000Z";
  assert.throws(
    () => buildCiSignalArtifact({
      sourceRun: sourceRun(),
      jobs: [invalid],
      relevance: { status: "current", pullRequest: 7 },
    }),
    /precedes/u,
  );
});

test("workflow_run observer is read-only and never checks out pull request code", async () => {
  const source = await readFile(join(repositoryRoot, ".github", "workflows", "ci-feedback.yml"), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(workflow.on.workflow_run, { workflows: ["CI"], types: ["completed"] });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.observe.permissions, {
    actions: "read",
    contents: "read",
    "pull-requests": "read",
  });
  const checkout = workflow.jobs.observe.steps[0];
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.doesNotMatch(source, /pull_request\.head|head_sha/u);
  assert.equal(workflow.jobs.observe.steps.some(({ run }) => /pnpm install/u.test(run ?? "")), false);
});

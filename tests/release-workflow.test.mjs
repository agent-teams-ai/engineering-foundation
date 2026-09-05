// oxlint-disable max-lines -- workflow contract coverage remains one auditable suite.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  readStreamText,
  releasePullRequestContentViolations,
  releasePullRequestFileViolations,
} from "../scripts/check-release-pr-files.mjs";
import { validateReleaseCodeqlEvidence } from "../scripts/check-release-codeql-evidence.mjs";
import { selectReleaseCiRun } from "../scripts/select-release-ci-run.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reviewRouterRevision = "75cbecab131d74021677fcd1fb21962994d306b8";
const reviewRouterSecretName =
  "REVIEWROUTER_CODEX_AUTH_JSON_R1316243988_P2410642c6217c966_E10_dd08bd02179b09e1a3d456c9cc962f9d";

async function workflow(name) {
  return parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", name), "utf8"),
  );
}

function assertReviewRouterInteractionRuntime(
  reviewInteraction,
  reviewInteractionSource,
) {
  const interactionJob = reviewInteraction.jobs.interaction;
  assert.deepEqual(interactionJob.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
    "id-token": "write",
  });
  assert.deepEqual(reviewInteraction.on, {
    pull_request_review_comment: { types: ["created", "edited"] },
    issue_comment: { types: ["created", "edited"] },
    workflow_dispatch: null,
  });
  assert.deepEqual(reviewInteraction.permissions, {});
  assert.equal(
    interactionJob.if,
    "${{ github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot') }}",
  );
  assert.equal(interactionJob["runs-on"], "ubuntu-24.04");
  assert.equal(interactionJob.env.RR_RUNTIME_REF, reviewRouterRevision);
  assert.equal(interactionJob.env.REVIEWROUTER_RUNTIME_CONFIG_MODE, "oidc");
  assert.equal(interactionJob.env.REVIEWROUTER_COMMENT_TOKEN_MODE, "app-oidc");
  assert.equal(interactionJob.env.REVIEW_ROUTER_MEMORY_ENABLED, "true");
  const interactionCheckout = interactionJob.steps.find(
    ({ name }) => name === "Checkout ReviewRouter interaction runtime",
  );
  const interactionNodeSetup = interactionJob.steps.find(
    ({ name }) => name === "Setup Node.js",
  );
  const interactionPreflight = interactionJob.steps.find(
    ({ name }) => name === "Preflight ReviewRouter interaction",
  );
  const interactionAuthRestore = interactionJob.steps.find(
    ({ name }) => name === "Restore Codex subscription auth for discussion replies",
  );
  const interactionRun = interactionJob.steps.find(
    ({ name }) => name === "Run ReviewRouter interaction",
  );
  assert.equal(
    interactionCheckout.uses,
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  );
  assert.equal(interactionCheckout.with.repository, "777genius/review-router");
  assert.equal(interactionCheckout.with.ref, "${{ env.RR_RUNTIME_REF }}");
  assert.equal(interactionCheckout.with["persist-credentials"], false);
  assert.equal(
    interactionNodeSetup.uses,
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  );
  assert.equal(interactionPreflight.env.REVIEW_ROUTER_MODE, "interaction-preflight");
  assert.equal(interactionPreflight.run, "node .reviewrouter-runtime/dist/index.js");
  assert.equal(
    interactionAuthRestore.env.CODEX_AUTH_JSON,
    "${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
  );
  assert.match(interactionAuthRestore.run, /chmod 600 "\$CODEX_HOME\/auth\.json"/u);
  assert.equal(interactionRun.env.REVIEW_ROUTER_MODE, "interaction");
  assert.equal(interactionRun.run, "node .reviewrouter-runtime/dist/index.js");
  assert.deepEqual(Object.keys(interactionJob).toSorted(), [
    "env",
    "if",
    "name",
    "permissions",
    "runs-on",
    "steps",
  ]);
  assert.match(
    reviewInteractionSource,
    /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/u,
  );
  assert.match(reviewInteractionSource, /\.reviewrouter-runtime\/dist\/index\.js/u);
  assert.match(reviewInteractionSource, /CODEX_HOME\/auth\.json/u);
  assert.doesNotMatch(reviewInteractionSource, /pnpm (?:install|action-setup)/u);
}

function assertExactReleaseRunBinding(attestation, release, ci) {
  const jobTimeoutSeconds =
    release.jobs["attest-release-pr"]["timeout-minutes"] * 60;
  const requiredContexts = attestation.run.match(/^\s*ci_contexts=\(([^)]+)\)$/mu)[1].split(" ");
  const criticalPathMinutes = (jobId) => {
    const { needs = [], "timeout-minutes": timeout } = ci.jobs[jobId] ?? {};
    assert.ok(Number.isInteger(timeout), `${jobId} must be bounded`);
    return timeout + Math.max(0, ...[needs].flat().map(criticalPathMinutes));
  };
  const longestRequiredCiPathSeconds = Math.max(...requiredContexts.map(criticalPathMinutes)) * 60;
  const deadlineEntries = [...attestation.run.matchAll(
    /^\s*(deadline|final_verification_deadline)=\$\(\(SECONDS \+ ([0-9]+)\)\)$/gmu,
  )];
  const deadlines = new Map(deadlineEntries.map(
    ([, name, seconds]) => [name, Number.parseInt(seconds, 10)],
  ));
  const primaryDeadlineSeconds = deadlines.get("deadline");
  const finalVerificationSeconds = deadlines.get("final_verification_deadline");

  assert.equal(jobTimeoutSeconds, 60 * 60);
  assert.equal(deadlines.size, 2);
  assert.equal(primaryDeadlineSeconds, 55 * 60);
  assert.equal(finalVerificationSeconds, 60);
  assert.equal(primaryDeadlineSeconds - longestRequiredCiPathSeconds, 3 * 60);
  assert.match(attestation.run, /actions\/workflows\/ci\.yml\/dispatches/u);
  assert.match(attestation.run, /-F return_run_details=true/u);
  assert.match(attestation.run, /\.workflow_run_id \/\/ ""/u);
  assert.match(
    attestation.run,
    /expected_run_url="\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{bound_run_id\}"/u,
  );
  assert.match(attestation.run, /bound_run_url.*expected_run_url/su);
  assert.match(attestation.run, /actions\/runs\/\$\{bound_run_id\}"/u);
  assert.equal((attestation.run.match(/run_id.*bound_run_id/gu) ?? []).length, 2);
  assert.equal(
    (attestation.run.match(/run_path.*\.github\/workflows\/ci\.yml/gu) ?? [])
      .length,
    2,
  );
  assert.match(attestation.run, /run_event.*bound_run_event/su);
  assert.match(attestation.run, /run_head_branch.*changeset-release\/main/su);
  assert.match(attestation.run, /run_head_sha.*head_sha/su);
  assert.match(attestation.run, /bound_run_attempt.*"1"/su);
  assert.match(
    attestation.run,
    /actions\/runs\/\$\{bound_run_id\}\/attempts\/\$\{bound_run_attempt\}\/jobs/u,
  );
  assert.match(attestation.run, /if ! jobs="\$\(gh api/u);
  assert.match(attestation.run, /\[length, first\.status \/\/ "missing"\]/u);
  assert.match(attestation.run, /job_count > 1/u);
  assert.match(attestation.run, /job_count == 0.*run_status.*completed/su);
  assert.match(attestation.run, /run_conclusion.*success/su);
  assert.match(attestation.run, /final_bound_run="\$\(gh api/u);
  assert.match(attestation.run, /final_run_status.*completed/su);
  assert.match(attestation.run, /final_run_conclusion.*success/su);
  assert.match(
    attestation.run,
    /while \(\( SECONDS < final_verification_deadline \)\); do/u,
  );
  assert.equal(
    jobTimeoutSeconds - primaryDeadlineSeconds - finalVerificationSeconds,
    4 * 60,
  );
  assert.ok(
    attestation.run.lastIndexOf("final_bound_run") <
      attestation.run.lastIndexOf('post_status "${ci_contexts[index]}" success'),
  );
  assert.doesNotMatch(attestation.run, /baseline_run_id/u);
  assert.doesNotMatch(attestation.run, /sort_by\(\.id\) \| first/u);
  assert.match(
    attestation.run,
    /commits\/\$\{head_sha\}\/check-runs[\s\S]*check_name=CodeQL[\s\S]*filter=all/u,
  );
  assert.doesNotMatch(attestation.run, /sort_by\(\.id\) \| last/u);
}

function assertFinalCodeqlReadsFailClosed(attestationSource) {
  const immediatelyValidatedReads = [
    /observed_codeql_run="\$\{final_codeql_run\}"\n\s+require_final_codeql_snapshot/u,
    /observed_codeql_jobs="\$\{final_codeql_jobs\}"\n\s+require_final_codeql_snapshot/u,
    /observed_codeql_analyze_check="\$\{final_codeql_analyze_check\}"\n\s+require_final_codeql_snapshot/u,
    /observed_codeql_checks="\$\{final_codeql_checks\}"\n\s+require_final_codeql_snapshot/u,
    /observed_codeql_check_suite="\$\{final_codeql_check_suite\}"\n\s+require_final_codeql_snapshot/u,
    /observed_codeql_analyses="\$\{final_codeql_analyses\}"\n\s+require_final_codeql_snapshot/u,
    /observed_codeql_run="\$\{post_codeql_run\}"\n\s+require_final_codeql_snapshot/u,
    /observed_pull_request="\$\{post_pull_request\}"\n\s+require_final_codeql_snapshot/u,
  ];
  for (const pattern of immediatelyValidatedReads) {
    assert.match(attestationSource, pattern);
  }
}

function assertPaginatedEvidenceFailClosed(attestationSource) {
  assert.equal(
    (attestationSource.match(/paginated_object_collection jobs/gu) ?? []).length,
    2,
  );
  assert.equal(
    (attestationSource.match(/paginated_object_collection check_runs/gu) ?? [])
      .length,
    2,
  );
  assert.equal(
    (attestationSource.match(
      /if ! [a-z_]+_analyses="\$\(paginated_array_collection/gu,
    ) ?? []).length,
    2,
  );
  assert.match(
    attestationSource,
    /fetch_paginated_pages\(\) \{\n\s+gh api --paginate --slurp "\$@"/u,
  );
  assert.equal(
    (attestationSource.match(
      /if ! [a-z_]+_pages="\$\(fetch_paginated_pages/gu,
    ) ?? []).length,
    6,
  );
  assert.equal(
    (attestationSource.match(
      /fail_attestation "Release PR CodeQL pagination evidence is malformed"/gu,
    ) ?? []).length,
    6,
  );
  assert.match(attestationSource, /incomplete paginated object collection/u);
}

function exactPullRequestRun(overrides = {}) {
  const repository = "agent-teams-ai/engineering-foundation";
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  return {
    id: 123,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_branch: "changeset-release/main",
    head_sha: headSha,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/${repository}/actions/runs/123`,
    head_repository: { full_name: repository },
    pull_requests: [
      {
        number: 127,
        head: { ref: "changeset-release/main", sha: headSha },
        base: { ref: "main", sha: baseSha },
      },
    ],
    ...overrides,
  };
}

const exactRunExpectation = {
  repository: "agent-teams-ai/engineering-foundation",
  apiUrl: "https://api.github.com",
  serverUrl: "https://github.com",
  branch: "changeset-release/main",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  pullRequestNumber: 127,
};

function exactCodeqlEvidence() {
  const startedAt = "2026-09-04T12:00:00Z";
  const checkStartedAt = "2026-09-04T12:00:30Z";
  const analysisCreatedAt = "2026-09-04T12:00:31Z";
  const checkCompletedAt = "2026-09-04T12:00:32Z";
  const completedAt = "2026-09-04T12:00:40Z";
  const pullRequest = {
    number: exactRunExpectation.pullRequestNumber,
    head: {
      ref: exactRunExpectation.branch,
      sha: exactRunExpectation.headSha,
      repo: { full_name: exactRunExpectation.repository },
    },
    base: {
      ref: "main",
      sha: exactRunExpectation.baseSha,
      repo: { full_name: exactRunExpectation.repository },
    },
    state: "open",
  };
  return {
    pullRequest,
    run: {
      id: 123,
      url:
        "https://api.github.com/repos/agent-teams-ai/engineering-foundation/actions/runs/123",
      path: ".github/workflows/codeql.yml",
      event: "workflow_dispatch",
      head_branch: exactRunExpectation.branch,
      head_sha: exactRunExpectation.headSha,
      run_attempt: 1,
      html_url:
        "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/123",
      jobs_url:
        "https://api.github.com/repos/agent-teams-ai/engineering-foundation/actions/runs/123/jobs",
      rerun_url:
        "https://api.github.com/repos/agent-teams-ai/engineering-foundation/actions/runs/123/rerun",
      head_repository: { full_name: exactRunExpectation.repository },
      pull_requests: [pullRequest],
      status: "completed",
      conclusion: "success",
    },
    jobs: {
      jobs: [{
        id: 456,
        url:
          "https://api.github.com/repos/agent-teams-ai/engineering-foundation/actions/jobs/456",
        run_id: 123,
        run_attempt: 1,
        run_url:
          "https://api.github.com/repos/agent-teams-ai/engineering-foundation/actions/runs/123",
        check_run_url:
          "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-runs/456",
        head_sha: exactRunExpectation.headSha,
        html_url:
          "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/123/job/456",
        name: "analyze",
        status: "completed",
        conclusion: "success",
        started_at: startedAt,
        completed_at: completedAt,
      }],
    },
    analyzeCheck: {
      id: 456,
      url:
        "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-runs/456",
      html_url:
        "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/123/job/456",
      name: "analyze",
      app: { id: 15368 },
      check_suite: { id: 458 },
      head_sha: exactRunExpectation.headSha,
      details_url:
        "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/123/job/456",
      status: "completed",
      conclusion: "success",
    },
    analyses: [{
      id: 901,
      url:
        "https://api.github.com/repos/agent-teams-ai/engineering-foundation/code-scanning/analyses/901",
      ref: `refs/heads/${exactRunExpectation.branch}`,
      commit_sha: exactRunExpectation.headSha,
      analysis_key: ".github/workflows/codeql.yml:analyze",
      category: "release-attestation-123-1",
      environment: "{}",
      warning: "",
      tool: { name: "CodeQL" },
      created_at: analysisCreatedAt,
      sarif_id: "dde4b0bc-a8a2-11f1-82f5-b5928a50418b",
    }],
    checkRuns: {
      check_runs: [{
        id: 789,
        url:
          "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-runs/789",
        html_url:
          "https://github.com/agent-teams-ai/engineering-foundation/runs/789",
        name: "CodeQL",
        app: { id: 57789 },
        check_suite: { id: 900 },
        head_sha: exactRunExpectation.headSha,
        details_url:
          "https://github.com/agent-teams-ai/engineering-foundation/runs/789",
        status: "completed",
        conclusion: "success",
        started_at: checkStartedAt,
        completed_at: checkCompletedAt,
      }],
    },
    checkSuite: {
      id: 900,
      url:
        "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-suites/900",
      check_runs_url:
        "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-suites/900/check-runs",
      head_sha: exactRunExpectation.headSha,
      head_branch: exactRunExpectation.branch,
      app: { id: 57789 },
      pull_requests: [pullRequest],
      status: "completed",
      conclusion: "success",
      created_at: checkStartedAt,
      updated_at: checkCompletedAt,
    },
  };
}

function asFinalEvidence(candidate) {
  return {
    ...candidate,
    postRun: structuredClone(candidate.run),
    postPullRequest: structuredClone(candidate.pullRequest),
  };
}

test("release CodeQL evidence binds one dispatch, analysis, check, and PR tuple", () => {
  const evidence = exactCodeqlEvidence();
  const expectation = { ...exactRunExpectation, runId: 123 };
  const receipt = validateReleaseCodeqlEvidence(evidence, expectation);
  assert.deepEqual(receipt, {
    analysisId: 901,
    analyzeCheckId: 456,
    analyzeCheckSuiteId: 458,
    analyzeId: 456,
    checkId: 789,
    checkSuiteId: 900,
    runId: 123,
    sarifId: "dde4b0bc-a8a2-11f1-82f5-b5928a50418b",
  });

  const noRunAssociation = structuredClone(evidence);
  noRunAssociation.run.pull_requests = [];
  assert.deepEqual(
    validateReleaseCodeqlEvidence(noRunAssociation, expectation),
    receipt,
  );

  const attemptTwo = structuredClone(evidence);
  attemptTwo.run.run_attempt = 2;
  assert.throws(
    () => validateReleaseCodeqlEvidence(attemptTwo, expectation),
    /workflow run identity differs/u,
  );

  const rerunRace = asFinalEvidence(evidence);
  rerunRace.postRun.run_attempt = 2;
  assert.throws(
    () => validateReleaseCodeqlEvidence(rerunRace, expectation, receipt),
    /workflow run identity differs/u,
  );

  const pullRequestRace = asFinalEvidence(evidence);
  pullRequestRace.postPullRequest.head.sha = "c".repeat(40);
  assert.throws(
    () => validateReleaseCodeqlEvidence(pullRequestRace, expectation, receipt),
    /provenance differs/u,
  );

  for (const malformedId of [[123], { value: 123 }, "123", 2 ** 53]) {
    const malformedRun = structuredClone(evidence);
    malformedRun.run.id = malformedId;
    assert.throws(
      () => validateReleaseCodeqlEvidence(malformedRun, expectation),
      /workflow run identity differs/u,
    );
  }

  const malformedAnalyzeId = structuredClone(evidence);
  malformedAnalyzeId.jobs.jobs[0].id = [456];
  assert.throws(
    () => validateReleaseCodeqlEvidence(malformedAnalyzeId, expectation),
    /CodeQL jobs entry 0 ID is malformed/u,
  );

  const malformedUnrelatedJob = structuredClone(evidence);
  malformedUnrelatedJob.jobs.jobs.push(null);
  assert.throws(
    () => validateReleaseCodeqlEvidence(malformedUnrelatedJob, expectation),
    /entry 1 is malformed/u,
  );

  const malformedCompetingCheck = structuredClone(evidence);
  malformedCompetingCheck.checkRuns.check_runs.push({
    ...structuredClone(malformedCompetingCheck.checkRuns.check_runs[0]),
    id: 790,
    app: { id: "57789" },
    conclusion: "failure",
  });
  assert.throws(
    () => validateReleaseCodeqlEvidence(malformedCompetingCheck, expectation),
    /app ID is malformed/u,
  );

  const malformedUnrelatedAnalysis = structuredClone(evidence);
  malformedUnrelatedAnalysis.analyses.push(null);
  assert.throws(
    () => validateReleaseCodeqlEvidence(malformedUnrelatedAnalysis, expectation),
    /entry 1 is malformed/u,
  );

  const changedAnalyzeCheck = structuredClone(evidence);
  changedAnalyzeCheck.jobs.jobs[0].check_run_url =
    "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-runs/458";
  assert.throws(
    () => validateReleaseCodeqlEvidence(changedAnalyzeCheck, expectation),
    /analyze check run identity differs/u,
  );

  const aliasedAnalyzeCheck = structuredClone(evidence);
  aliasedAnalyzeCheck.jobs.jobs[0].check_run_url =
    aliasedAnalyzeCheck.checkRuns.check_runs[0].url;
  aliasedAnalyzeCheck.analyzeCheck = structuredClone(
    aliasedAnalyzeCheck.checkRuns.check_runs[0],
  );
  assert.throws(
    () => validateReleaseCodeqlEvidence(aliasedAnalyzeCheck, expectation),
    /analyze check run identity differs/u,
  );

  const duplicateAnalyze = structuredClone(evidence);
  duplicateAnalyze.jobs.jobs.push(structuredClone(duplicateAnalyze.jobs.jobs[0]));
  assert.throws(
    () => validateReleaseCodeqlEvidence(duplicateAnalyze, expectation),
    /exactly one matching/u,
  );

  const unrelatedPullRequest = structuredClone(evidence);
  unrelatedPullRequest.pullRequest.number = 128;
  assert.throws(
    () => validateReleaseCodeqlEvidence(unrelatedPullRequest, expectation),
    /provenance differs/u,
  );

  const unrelatedCheck = structuredClone(evidence);
  unrelatedCheck.checkRuns.check_runs[0].started_at = "2026-09-04T11:59:59Z";
  assert.throws(
    () => validateReleaseCodeqlEvidence(unrelatedCheck, expectation),
    /outside the dispatched analyze job/u,
  );

  const wrongCheckHead = structuredClone(evidence);
  wrongCheckHead.checkRuns.check_runs[0].head_sha = "c".repeat(40);
  assert.throws(
    () => validateReleaseCodeqlEvidence(wrongCheckHead, expectation),
    /check identity differs/u,
  );

  const contradictoryAnalysisUrl = structuredClone(evidence);
  contradictoryAnalysisUrl.analyses[0].url =
    "https://api.github.com/repos/agent-teams-ai/engineering-foundation/code-scanning/analyses/902";
  assert.throws(
    () => validateReleaseCodeqlEvidence(contradictoryAnalysisUrl, expectation),
    /identity differs/u,
  );

  const contradictorySuiteUrl = structuredClone(evidence);
  contradictorySuiteUrl.checkSuite.url =
    "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-suites/901";
  assert.throws(
    () => validateReleaseCodeqlEvidence(contradictorySuiteUrl, expectation),
    /check suite identity differs/u,
  );

  const wrongCategory = structuredClone(evidence);
  wrongCategory.analyses[0].category = ".github/workflows/codeql.yml:analyze";
  assert.throws(
    () => validateReleaseCodeqlEvidence(wrongCategory, expectation),
    /exactly one matching/u,
  );

  const delayedCheck = structuredClone(evidence);
  delayedCheck.checkRuns.check_runs[0].started_at = "2026-09-04T12:02:00Z";
  delayedCheck.checkRuns.check_runs[0].completed_at = "2026-09-04T12:02:02Z";
  delayedCheck.checkSuite.created_at = "2026-09-04T12:01:59Z";
  delayedCheck.checkSuite.updated_at = "2026-09-04T12:02:03Z";
  assert.doesNotThrow(() =>
    validateReleaseCodeqlEvidence(delayedCheck, expectation));

  const replacement = structuredClone(evidence);
  replacement.checkRuns.check_runs[0].id = 790;
  replacement.checkRuns.check_runs[0].url =
    "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-runs/790";
  replacement.checkRuns.check_runs[0].html_url =
    "https://github.com/agent-teams-ai/engineering-foundation/runs/790";
  replacement.checkRuns.check_runs[0].details_url =
    "https://github.com/agent-teams-ai/engineering-foundation/runs/790";
  assert.throws(
    () => validateReleaseCodeqlEvidence(asFinalEvidence(replacement), expectation, receipt),
    /checkId changed identity/u,
  );

  const competingCheck = structuredClone(evidence);
  competingCheck.checkRuns.check_runs.push({
    ...structuredClone(competingCheck.checkRuns.check_runs[0]),
    id: 791,
    url:
      "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-runs/791",
    conclusion: "failure",
    details_url:
      "https://github.com/agent-teams-ai/engineering-foundation/runs/791",
  });
  assert.throws(
    () => validateReleaseCodeqlEvidence(
      asFinalEvidence(competingCheck),
      expectation,
      receipt,
    ),
    /exactly one matching/u,
  );

  const competingCheckBeyondFirstPage = structuredClone(evidence);
  competingCheckBeyondFirstPage.checkRuns.check_runs.unshift(
    ...Array.from({ length: 100 }, (_, index) => {
      const id = 1_000 + index;
      return {
        ...structuredClone(evidence.checkRuns.check_runs[0]),
        id,
        url:
          `https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-runs/${id}`,
        name: `unrelated-${index}`,
        app: { id: 1 },
      };
    }),
  );
  competingCheckBeyondFirstPage.checkRuns.check_runs.push(
    structuredClone(competingCheckBeyondFirstPage.checkRuns.check_runs[100]),
  );
  assert.throws(
    () => validateReleaseCodeqlEvidence(
      asFinalEvidence(competingCheckBeyondFirstPage),
      expectation,
      receipt,
    ),
    /exactly one matching/u,
  );

  const competingAnalysis = structuredClone(evidence);
  competingAnalysis.analyses.push({
    ...structuredClone(competingAnalysis.analyses[0]),
    id: 902,
    url:
      "https://api.github.com/repos/agent-teams-ai/engineering-foundation/code-scanning/analyses/902",
    sarif_id: "eed4b0bc-a8a2-11f1-82f5-b5928a50418b",
  });
  assert.throws(
    () => validateReleaseCodeqlEvidence(
      asFinalEvidence(competingAnalysis),
      expectation,
      receipt,
    ),
    /exactly one matching/u,
  );

  const competingAnalysisBeyondFirstPage = structuredClone(evidence);
  competingAnalysisBeyondFirstPage.analyses.unshift(
    ...Array.from({ length: 100 }, (_, index) => {
      const id = 2_000 + index;
      return {
        ...structuredClone(evidence.analyses[0]),
        id,
        url:
          `https://api.github.com/repos/agent-teams-ai/engineering-foundation/code-scanning/analyses/${id}`,
        ref: `refs/heads/unrelated-${index}`,
      };
    }),
  );
  competingAnalysisBeyondFirstPage.analyses.push(
    structuredClone(competingAnalysisBeyondFirstPage.analyses[100]),
  );
  assert.throws(
    () => validateReleaseCodeqlEvidence(
      asFinalEvidence(competingAnalysisBeyondFirstPage),
      expectation,
      receipt,
    ),
    /exactly one matching/u,
  );
});

test("release CodeQL evidence rejects cross-producer identity aliases", () => {
  const expectation = { ...exactRunExpectation, runId: 123 };
  const aliasedProducerCheck = exactCodeqlEvidence();
  aliasedProducerCheck.checkRuns.check_runs[0].id = 456;
  aliasedProducerCheck.checkRuns.check_runs[0].url =
    "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-runs/456";
  aliasedProducerCheck.checkRuns.check_runs[0].html_url =
    "https://github.com/agent-teams-ai/engineering-foundation/runs/456";
  aliasedProducerCheck.checkRuns.check_runs[0].details_url =
    "https://github.com/agent-teams-ai/engineering-foundation/runs/456";
  assert.throws(
    () => validateReleaseCodeqlEvidence(aliasedProducerCheck, expectation),
    /analyze and GitHub Advanced Security check identities must differ/u,
  );

  const aliasedProducerSuite = exactCodeqlEvidence();
  aliasedProducerSuite.checkRuns.check_runs[0].check_suite.id = 458;
  aliasedProducerSuite.checkSuite.id = 458;
  aliasedProducerSuite.checkSuite.url =
    "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-suites/458";
  aliasedProducerSuite.checkSuite.check_runs_url =
    "https://api.github.com/repos/agent-teams-ai/engineering-foundation/check-suites/458/check-runs";
  assert.throws(
    () => validateReleaseCodeqlEvidence(aliasedProducerSuite, expectation),
    /analyze and GitHub Advanced Security suite identities must differ/u,
  );
});

test("release CI selection reuses only one exact attempt-1 pull request run", () => {
  assert.deepEqual(
    selectReleaseCiRun({ workflow_runs: [exactPullRequestRun()] }, exactRunExpectation),
    {
      id: 123,
      event: "pull_request",
      url: "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/123",
    },
  );
  for (const incompatible of [
    { run_attempt: 2 },
    { status: "completed", conclusion: "action_required" },
    { event: "workflow_dispatch" },
    { head_repository: { full_name: "attacker/fork" } },
    { html_url: "https://example.test/actions/runs/123" },
    { pull_requests: [] },
    {
      pull_requests: [
        {
          number: 127,
          head: { ref: "changeset-release/main", sha: "b".repeat(40) },
          base: { ref: "main", sha: "c".repeat(40) },
        },
      ],
    },
  ]) {
    assert.equal(
      selectReleaseCiRun(
        { workflow_runs: [exactPullRequestRun(incompatible)] },
        exactRunExpectation,
      ),
      null,
    );
  }
  assert.throws(
    () =>
      selectReleaseCiRun(
        {
          workflow_runs: [
            exactPullRequestRun(),
            exactPullRequestRun({
              id: 124,
              html_url:
                "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/124",
            }),
          ],
        },
        exactRunExpectation,
      ),
    /Multiple exact attempt-1/u,
  );
});

test("CI concurrency isolates pull request checks from attester dispatches", async () => {
  const ci = await workflow("ci.yml");
  const codeql = await workflow("codeql.yml");
  const requiredLifecycleEvents = [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ];
  const readyPullRequestCondition =
    "${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}";
  assert.deepEqual(ci.on.pull_request.types, requiredLifecycleEvents);
  assert.deepEqual(codeql.on.pull_request.types, requiredLifecycleEvents);
  assert.equal(codeql.on.workflow_dispatch, null);
  assert.equal(ci.jobs["dependency-review"].if, undefined);
  assert.equal(ci.jobs["linux-static"].if, readyPullRequestCondition);
  assert.equal(codeql.jobs.analyze.if, readyPullRequestCondition);
  const codeqlAnalyze = codeql.jobs.analyze.steps.find(
    ({ uses }) => uses?.startsWith("github/codeql-action/analyze@"),
  );
  assert.equal(codeqlAnalyze.id, "analyze");
  assert.equal(
    codeqlAnalyze.with.category,
    "${{ github.event_name == 'workflow_dispatch' && format('release-attestation-{0}-{1}', github.run_id, github.run_attempt) || '' }}",
  );
  assert.equal(
    ci.concurrency.group,
    "foundation-ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}",
  );
  assert.equal(ci.concurrency["cancel-in-progress"], true);
});

test("release pipeline keeps hosted review separate from generated-diff attestation", async () => {
  const release = await workflow("release.yml");
  const ci = await workflow("ci.yml");
  const review = await workflow("reviewrouter-codex.yml");
  const reviewInteraction = await workflow("reviewrouter-interaction.yml");
  const reviewInteractionSource = await readFile(
    join(repositoryRoot, ".github", "workflows", "reviewrouter-interaction.yml"),
    "utf8",
  );
  const releaseJob = release.jobs.release;
  const releaseBinding = releaseJob.steps.find(({ id }) => id === "release-pr");
  const attestationSteps = release.jobs["attest-release-pr"].steps;
  const attestation = attestationSteps.find(
    ({ name }) => name === "Dispatch and attest release pull request checks",
  );
  assert.equal(releaseJob["timeout-minutes"], 30);
  const attestationIndex = attestationSteps.indexOf(attestation);
  const attestationPnpmSetupIndex = attestationSteps.findIndex(
    ({ uses }) => uses?.startsWith("pnpm/setup@"),
  );
  const attestationNodeSetupIndex = attestationSteps.findIndex(
    ({ uses }) => uses?.startsWith("actions/setup-node@"),
  );
  const attestationInstallIndex = attestationSteps.findIndex(
    ({ run }) => run === "pnpm install --frozen-lockfile --ignore-scripts",
  );

  assert.equal(releaseJob.outputs.pullRequestNumber, "${{ steps.release-pr.outputs.number }}");
  assert.equal(releaseJob.outputs.pullRequestBaseSha, "${{ steps.release-pr.outputs.base_sha }}");
  assert.equal(releaseJob.outputs.pullRequestHeadSha, "${{ steps.release-pr.outputs.head_sha }}");
  assert.equal(releaseBinding.env.PROCESSED_MAIN_SHA, "${{ github.sha }}");
  assert.match(releaseBinding.run, /deadline=\$\(\(SECONDS \+ 30\)\)/u);
  assert.match(releaseBinding.run, /git ls-remote --refs origin/u);
  assert.match(releaseBinding.run, /check-release-pr-freshness\.mjs/u);
  assert.match(releaseBinding.run, /check-release-pr-files\.mjs/u);
  assert.match(releaseBinding.run, /stable_branch_head_sha/u);
  assert.match(releaseBinding.run, /stable_current_main_sha/u);
  assert.ok(
    releaseBinding.run.indexOf("check-release-pr-freshness.mjs") <
      releaseBinding.run.indexOf("printf 'number=%s\\n'"),
  );
  assert.ok(
    releaseBinding.run.indexOf("check-release-pr-files.mjs") <
      releaseBinding.run.indexOf("printf 'number=%s\\n'"),
  );
  assert.deepEqual([releaseJob.permissions["id-token"], releaseJob.permissions.contents, releaseJob.steps.find(({ run }) => run?.startsWith("pnpm install"))?.run, releaseJob.steps.find((step) => step.id === "changesets").with.createGithubReleases], ["write", "write", "pnpm install --frozen-lockfile --ignore-scripts", false]);
  assert.match(attestation.run, /node scripts\/check-release-pr-files\.mjs/u);
  assert.ok(attestationPnpmSetupIndex > 0);
  assert.ok(attestationNodeSetupIndex > attestationPnpmSetupIndex);
  assert.ok(attestationInstallIndex > attestationNodeSetupIndex);
  assert.ok(attestationIndex > attestationInstallIndex);
  assert.equal(
    attestationSteps[attestationPnpmSetupIndex].uses,
    "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b",
  );
  assert.deepEqual(
    attestationSteps[attestationPnpmSetupIndex].with,
    { install: false },
  );
  assert.equal(
    attestationSteps[attestationNodeSetupIndex].uses,
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  );
  assert.equal(
    attestationSteps[attestationNodeSetupIndex].with["node-version-file"],
    ".node-version",
  );
  const changesetCoverage = ci.jobs["linux-static"].steps.find(
    ({ name }) => name === "Validate package Changeset coverage",
  );
  assert.equal(changesetCoverage.run, "pnpm changeset:coverage");
  assert.match(changesetCoverage.if, /pull_request[\s\S]*changeset-release\/main/u);
  assert.match(
    changesetCoverage.if,
    /head\.repo\.full_name != github\.repository/u,
  );
  assert.equal(changesetCoverage.env.FOUNDATION_CHANGESET_BASE_SHA, "${{ github.event.pull_request.base.sha }}");
  assert.equal(ci.jobs["linux-static"].steps.find(({ run }) => run === "pnpm release-owned-files:check").env.FOUNDATION_PR_HEAD_REPOSITORY, "${{ github.event.pull_request.head.repo.full_name }}");
  assert.equal(
    attestation.env.EXPECTED_RELEASE_BASE_SHA,
    "${{ needs.release.outputs.pullRequestBaseSha }}",
  );
  assert.equal(
    attestation.env.EXPECTED_RELEASE_HEAD_SHA,
    "${{ needs.release.outputs.pullRequestHeadSha }}",
  );
  assert.equal(attestation.env.PROCESSED_MAIN_SHA, "${{ github.sha }}");
  assert.equal(
    (attestation.run.match(/check-release-pr-freshness\.mjs/gu) ?? []).length,
    3,
  );
  assert.equal(
    (attestation.run.match(/git\/ref\/heads\/main/gu) ?? []).length,
    3,
  );
  assert.match(attestation.run, /--arg expectedHeadSha "\$\{head_sha\}"/u);
  assert.equal(
    (attestation.run.match(/--arg expectedBaseSha/gu) ?? []).length,
    3,
  );
  assert.equal(
    (attestation.run.match(/--arg expectedPullRequestNumber/gu) ?? []).length,
    3,
  );
  assert.match(attestation.run, /--base "\$\{base_sha\}" --head "\$\{head_sha\}"/u);
  assert.match(attestation.run, /selection_deadline=\$\(\(SECONDS \+ 30\)\)/u);
  assert.match(attestation.run, /select-release-ci-run\.mjs/u);
  assert.match(attestation.run, /-f event=pull_request/u);
  assert.match(attestation.run, /-f head_sha="\$\{head_sha\}"/u);
  assert.match(
    attestation.run,
    /if ! candidate_runs=.*SECONDS >= selection_deadline.*break.*sleep 5.*continue/su,
  );
  assert.ok(
    attestation.run.indexOf("select-release-ci-run.mjs") <
      attestation.run.indexOf("actions/workflows/ci.yml/dispatches"),
  );
  assert.match(attestation.run, /if \[\[ -z "\$\{bound_run_id\}" \]\]; then/u);
  assert.match(attestation.run, /actions\/workflows\/codeql\.yml\/dispatches/u);
  assert.ok(
    attestation.run.indexOf("actions/workflows/codeql.yml/dispatches") <
      attestation.run.indexOf("deadline=$((SECONDS + 3300))"),
  );
  assert.equal(
    (attestation.run.match(/check-release-codeql-evidence\.mjs/gu) ?? []).length,
    2,
  );
  assert.match(attestation.run, /check_name=CodeQL/u);
  assert.match(attestation.run, /\.app\.id == 57789/u);
  assert.match(attestation.run, /code-scanning\/analyses/u);
  assertPaginatedEvidenceFailClosed(attestation.run);
  assert.match(attestation.run, /check-suites\/\$\{codeql_check_suite_id\}/u);
  assert.equal((attestation.run.match(/-f filter=all/gu) ?? []).length, 2);
  assert.match(attestation.run, /final_codeql_analyses/u);
  assert.match(attestation.run, /final_codeql_checks/u);
  assert.match(attestation.run, /priorReceipt: \$priorReceipt/u);
  assert.match(attestation.run, /postRun: \$run/u);
  assert.match(attestation.run, /postPullRequest: \$pullRequest/u);
  assert.match(attestation.run, /validate_final_codeql_snapshot\(\) \{/u);
  assert.match(attestation.run, /require_final_codeql_snapshot\(\) \{/u);
  assert.equal(
    (attestation.run.match(/^\s+require_final_codeql_snapshot$/gmu) ?? []).length,
    8,
  );
  assertFinalCodeqlReadsFailClosed(attestation.run);
  assert.match(attestation.run, /require_final_release_pr_snapshot\(\) \{/u);
  assert.equal(
    (attestation.run.match(/^\s+require_final_release_pr_snapshot /gmu) ?? [])
      .length,
    2,
  );
  assert.match(
    attestation.run,
    /observed_pull_request="\$\{post_pull_request\}"\n\s+require_final_codeql_snapshot\n\s+require_final_release_pr_snapshot "\$\{final_current_main_sha\}"/u,
  );
  assert.equal(
    (attestation.run.match(/--argjson analyzeCheck/gu) ?? []).length,
    2,
  );
  assert.match(
    attestation.run,
    /check-runs\/\$\{codeql_analyze_check_id\}/u,
  );
  assert.match(
    attestation.run,
    /check-release-codeql-evidence\.mjs[\s\S]*?Final release PR CodeQL evidence changed identity/u,
  );
  assert.doesNotMatch(
    attestation.run,
    /check-release-codeql-evidence\.mjs[\s\S]*?then\s+sleep 5\s+continue\s+fi\s+final_run_verified=1/u,
  );
  assert.ok(
    attestation.run.lastIndexOf("post_codeql_run") >
      attestation.run.lastIndexOf("final_codeql_analyses"),
  );
  assert.ok(
    attestation.run.lastIndexOf("post_current_main_sha") <
      attestation.run.lastIndexOf('post_status "${ci_contexts[index]}" success'),
  );
  assert.match(attestation.run, /run_head_repository.*GITHUB_REPOSITORY/su);
  assert.equal((attestation.run.match(/pull_request_count\}" != "0"[\s\S]*?pull_request_count\}" != "1"/gu) ?? []).length, 2);
  assert.match(attestation.run, /run_pull_request_base_sha.*base_sha/su);
  assert.match(attestation.run, /final_run_pull_request_base_sha.*base_sha/su);
  assert.ok(
    attestation.run.lastIndexOf("check-release-pr-freshness.mjs") <
      attestation.run.lastIndexOf('post_status "${ci_contexts[index]}" success'),
  );
  assert.doesNotMatch(attestation.run, /ReviewGate|release_gate_context/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-codex\.yml/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-release\.yml/u);
  assert.doesNotMatch(attestation.run, /\.context == "ReviewRouter"/u);
  assert.doesNotMatch(attestation.run, /post_status "ReviewRouter"/u);
  assert.match(
    attestation.run,
    /ci_contexts=\(check windows-check macos-qualification\)/u,
  );
  assertExactReleaseRunBinding(attestation, release, ci);
  assert.match(attestation.run, /for context in "\$\{ci_contexts\[@\]\}"/u);
  assert.deepEqual(release.jobs["attest-release-pr"].permissions, {
    actions: "write",
    checks: "read",
    contents: "read",
    "pull-requests": "read",
    "security-events": "read",
    statuses: "write",
  });
  assert.equal(review.on.workflow_dispatch, undefined);
  assert.deepEqual(review.on.pull_request_target.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "converted_to_draft",
  ]);
  assert.equal(review.jobs["codex-review"].with.workflow_schema_version, 4);
  assert.match(review.jobs["codex-review"].if, /pull_request_target/u);
  assert.match(review.jobs["codex-review"].if, /user\.type != 'Bot'/u);
  assert.equal(
    review.jobs["codex-review"].secrets.CODEX_AUTH_JSON,
    "${{ secrets." + reviewRouterSecretName + " }}",
  );
  assertReviewRouterInteractionRuntime(
    reviewInteraction,
    reviewInteractionSource,
  );
});

test("release publishing requires real Buf and hermetic registry qualification", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const coverageRunner = await readFile(
    join(repositoryRoot, "scripts", "run-test-coverage.mjs"),
    "utf8",
  );
  const coverageManifestPath = join(repositoryRoot, "tests", "manifests", "coverage.v1.json");
  const coverageManifest = JSON.parse(await readFile(coverageManifestPath, "utf8"));
  for (const threshold of ["lines", "branches", "functions"]) {
    assert.ok(coverageManifest.thresholds[threshold] > 0);
    assert.match(coverageRunner, new RegExp(`config\\.thresholds\\.${threshold}`, "u"));
  }
  assert.match(manifest.scripts.check, /pnpm test:coverage:built/u);
  const ci = await workflow("ci.yml");
  assert.match(
    manifest.scripts["release:publish"],
    /registry-install-e2e:built/u,
  );
  assert.match(
    manifest.scripts["release:publish"],
    /buf-qualification:e2e:built/u,
  );
  assert.match(
    manifest.scripts["release:publish"],
    /published-compatibility:e2e/u,
  );
  assert.match(
    manifest.scripts["release:publish"],
    /node scripts\/release-publish\.mjs/u,
  );
  assert.match(
    manifest.scripts["release:publish"],
    /release-publish\.mjs && pnpm public-docs-release:e2e$/u,
  );
  assert.equal(
    manifest.scripts["public-docs-release:e2e"],
    "node scripts/public-docs-release-e2e.mjs",
  );
  assert.match(manifest.scripts["release:publish"], /^pnpm build &&/u);
  assert.doesNotMatch(
    manifest.scripts["release:publish"],
    /(?:^|&&\s*)(?:changeset publish|pnpm check)(?:\s|&&|$)/u,
  );
  assert.equal(
    manifest.scripts["registry-install-e2e:built"],
    "node scripts/registry-install-e2e.mjs",
  );
  assert.equal(
    manifest.scripts["npm-package-bootstrap:candidate-evidence"],
    "node scripts/npm-package-bootstrap-candidate-evidence.mjs",
  );
  assert.equal(ci.jobs["linux-registry"].steps.at(-1).run, "pnpm registry-install-e2e"); assert.equal(ci.jobs["linux-registry"]["timeout-minutes"], 25);
  const windowsRegistryCommands = ci.jobs["windows-registry"].steps
    .map((step) => step.run)
    .filter((command) => command !== undefined);
  assert.deepEqual(windowsRegistryCommands.slice(-3), [
    "pnpm build",
    "node scripts/prepare-package.mjs",
    "pnpm registry-install-e2e:built",
  ]);
  assert.equal(
    ci.jobs["windows-package"].steps.at(-1).run,
    "pnpm package:check",
  );
  assert.equal(ci.jobs["windows-package"]["timeout-minutes"], 45);
  assert.ok(ci.jobs["windows-check"].needs.includes("windows-package"));
  assert.ok(ci.jobs["windows-check"].needs.includes("windows-registry"));
  assert.equal(
    manifest.scripts["published-compatibility:e2e"],
    "node scripts/published-compatibility-e2e.mjs",
  );
  for (const name of ["linux-published", "windows-published"]) {
    const step = ci.jobs[name].steps.at(-1);
    assert.deepEqual([step.run, step.env], [
      "pnpm published-compatibility:e2e", { GH_TOKEN: "${{ github.token }}" },
    ]);
  }
  const windowsTestA = ci.jobs["windows-test-a"];
  const windowsTestB = ci.jobs["windows-test-b"];
  assert.deepEqual(
    [windowsTestA.name, windowsTestA.steps.at(-1).run],
    ["windows-test-a", "pnpm test:shard:built -- --shards 1,4"],
  );
  assert.deepEqual(
    [windowsTestB.name, windowsTestB.steps.at(-1).run],
    ["windows-test-b", "pnpm test:shard:built -- --shards 2,3"],
  );
  assert.deepEqual(ci.jobs.check.needs, [
    "dependency-review",
    "linux-static",
    "linux-test-1",
    "linux-test-2",
    "linux-test-3",
    "linux-test-4",
    "linux-coverage",
    "linux-package",
    "linux-registry",
    "linux-bootstrap-evidence",
    "linux-published",
  ]);
  assert.equal(
    ci.jobs.check.if,
    "${{ always() && (github.event_name != 'pull_request' || github.event.pull_request.draft == false) }}",
  );
  assert.match(ci.jobs.check.steps[0].uses, /^re-actors\/alls-green@[a-f0-9]{40}$/u);
});

test("release diff policy permits only version and generated changelog changes", () => {
  const evidence = {
    baseManifest: { name: "@agent-teams/engineering-foundation", version: "0.4.1" },
    headManifest: { name: "@agent-teams/engineering-foundation", version: "0.5.0" },
    baseChangelog: "# Changelog\n\n## 0.4.1\n",
    headChangelog: "# Changelog\n\n## 0.5.0\n\nNew capability.\n\n## 0.4.1\n",
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
    /only insert/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, version: "0.4.0" },
    })[0],
    /valid new version/u,
  );
});

test("release diff policy validates Changesets prerelease consumption", () => {
  const basePrereleaseState = {
    mode: "pre",
    tag: "rc",
    initialVersions: { "@agent-teams/engineering-foundation": "0.15.0" },
    changesets: [],
  };
  const evidence = {
    baseManifest: { name: "@agent-teams/engineering-foundation", version: "0.15.0" },
    headManifest: {
      name: "@agent-teams/engineering-foundation",
      version: "0.16.0-rc.0",
    },
    baseChangelog: "# Changelog\n\n## 0.15.0\n",
    headChangelog: "# Changelog\n\n## 0.16.0-rc.0\n\nNew capability.\n\n## 0.15.0\n",
    basePrereleaseState,
    headPrereleaseState: {
      ...basePrereleaseState,
      changesets: ["durable-document-writer"],
    },
  };

  assert.deepEqual(releasePullRequestContentViolations(evidence), []);
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headPrereleaseState: { ...evidence.headPrereleaseState, tag: "beta" },
    }).join("\n"),
    /only append consumed Changesets/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, version: "0.16.0-beta.0" },
    }).join("\n"),
    /matching prerelease state/u,
  );
  const withDocsInitialVersion = {
    ...evidence,
    docsBootstrapInitialVersionAddition: true,
    headPrereleaseState: { ...evidence.headPrereleaseState, initialVersions: {
      ...evidence.headPrereleaseState.initialVersions,
      "@agent-teams/docs-protocol": "0.0.0",
    } },
  };
  assert.deepEqual(releasePullRequestContentViolations(withDocsInitialVersion), []);
  const withMcpInitialVersion = {
    ...evidence,
    initialVersionAdditions: ["@agent-teams/docs-protocol-mcp"],
    headPrereleaseState: { ...evidence.headPrereleaseState, initialVersions: {
      ...evidence.headPrereleaseState.initialVersions,
      "@agent-teams/docs-protocol-mcp": "0.0.0",
    } },
  };
  assert.deepEqual(releasePullRequestContentViolations(withMcpInitialVersion), []);
  assert.match(
    releasePullRequestContentViolations({
      ...withMcpInitialVersion,
      initialVersionAdditions: [],
    }).join("\n"),
    /only append consumed Changesets/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...withDocsInitialVersion,
      docsBootstrapInitialVersionAddition: false,
    }).join("\n"),
    /only append consumed Changesets/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...withDocsInitialVersion,
      headPrereleaseState: {
        ...withDocsInitialVersion.headPrereleaseState,
        initialVersions: {
          ...withDocsInitialVersion.headPrereleaseState.initialVersions,
          unexpected: "1.0.0",
        },
      },
    }).join("\n"),
    /only append consumed Changesets/u,
  );
  const nextPrerelease = {
    ...evidence,
    baseManifest: { ...evidence.headManifest, version: "0.16.0-rc.0" },
    headManifest: { ...evidence.headManifest, version: "0.16.0-rc.1" },
  };
  assert.deepEqual(releasePullRequestContentViolations(nextPrerelease), []);
  assert.match(
    releasePullRequestContentViolations({
      ...nextPrerelease,
      headManifest: { ...nextPrerelease.headManifest, version: "0.16.0-rc.01" },
    }).join("\n"),
    /valid new version/u,
  );
});

test("release diff policy accepts only an exact prerelease exit", () => {
  const basePrereleaseState = {
    mode: "exit",
    tag: "rc",
    initialVersions: { "@agent-teams/engineering-foundation": "0.15.0" },
    changesets: ["durable-document-writer"],
  };
  const evidence = {
    baseManifest: {
      name: "@agent-teams/engineering-foundation",
      version: "0.16.0-rc.0",
    },
    headManifest: {
      name: "@agent-teams/engineering-foundation",
      version: "0.16.0",
    },
    baseChangelog: "# Changelog\n\n## 0.16.0-rc.0\n",
    headChangelog:
      "# Changelog\n\n## 0.16.0\n\nStable release.\n\n## 0.16.0-rc.0\n",
    basePrereleaseState,
    headPrereleaseState: undefined,
  };

  assert.deepEqual(releasePullRequestContentViolations(evidence), []);
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, version: "0.16.1" },
    }).join("\n"),
    /exact stable version/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      basePrereleaseState: { ...basePrereleaseState, mode: "pre" },
    }).join("\n"),
    /preserve a valid Changesets prerelease state/u,
  );
});

test("release diff policy accepts only normalized Changesets output", () => {
  const validFiles = [
    { filename: ".changeset/portable-agent-workflow.md", status: "removed" },
    { filename: "architecture/contracts/protobuf/control.json", status: "modified" },
    { filename: "architecture/contracts/events.yaml", status: "added" },
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
    releasePullRequestFileViolations([
      ...validFiles,
      { filename: "architecture/contracts/../escape.json", status: "added" },
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

test("release diff policy accepts normalized prerelease Changesets output", () => {
  const validFiles = [
    { filename: ".changeset/pre.json", status: "modified" },
    { filename: "architecture/public-api/engineering-foundation.json", status: "modified" },
    { filename: "packages/engineering-foundation/CHANGELOG.md", status: "modified" },
    { filename: "packages/engineering-foundation/package.json", status: "modified" },
  ];

  assert.deepEqual(releasePullRequestFileViolations(validFiles), []);
  assert.match(
    releasePullRequestFileViolations(
      validFiles.map((file) =>
        file.filename === ".changeset/pre.json" ? { ...file, status: "added" } : file,
      ),
    ).join("\n"),
    /forbidden change/u,
  );
});

test("release diff policy narrowly allows exit state deletion and rejects private noise", async () => {
  const exitFiles = [
    { filename: ".changeset/durable-document-writer.md", status: "removed" },
    { filename: ".changeset/pre.json", status: "removed" },
    { filename: "architecture/public-api/engineering-foundation.json", status: "modified" },
    { filename: "packages/engineering-foundation/CHANGELOG.md", status: "modified" },
    { filename: "packages/engineering-foundation/package.json", status: "modified" },
  ];

  assert.deepEqual(
    releasePullRequestFileViolations(exitFiles, { prereleaseExit: true }),
    [],
  );
  assert.match(
    releasePullRequestFileViolations(exitFiles).join("\n"),
    /forbidden change: \.changeset\/pre\.json/u,
  );
  assert.match(
    releasePullRequestFileViolations(
      [
        ...exitFiles,
        { filename: "spikes/source-dependency-parser/package.json", status: "modified" },
      ],
      { prereleaseExit: true },
    ).join("\n"),
    /forbidden change: spikes\/source-dependency-parser\/package\.json/u,
  );

  const config = JSON.parse(
    await readFile(join(repositoryRoot, ".changeset", "config.json"), "utf8"),
  );
  assert.deepEqual(config.privatePackages, { version: true, tag: false });
  assert.deepEqual(config.ignore, []);
});

test("release diff policy requires complete pairs from the promoted public catalog", () => {
  const validFiles = [
    { filename: ".changeset/unified-docs-protocol.md", status: "removed" },
    { filename: "packages/engineering-foundation/CHANGELOG.md", status: "modified" },
    { filename: "packages/engineering-foundation/package.json", status: "modified" },
  ];
  assert.deepEqual(releasePullRequestFileViolations(validFiles), []);
  assert.match(
    releasePullRequestFileViolations(
      [...validFiles, { filename: "packages/docs-protocol/package.json", status: "modified" }],
    ).join("\n"),
    /must modify packages\/docs-protocol\/CHANGELOG\.md/u,
  );
});

test("release diff policy reads piped GitHub evidence through portable stdin", async () => {
  assert.equal(
    await readStreamText(Readable.from([Buffer.from('[{"filename":'), '"safe"}]'])),
    '[{"filename":"safe"}]',
  );
});

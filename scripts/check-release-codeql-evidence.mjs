import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { readStreamText } from "./check-release-pr-files.mjs";

const exactShaPattern = /^[0-9a-f]{40}$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;

function requireString(value, label, pattern = /\S/u) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function requirePositiveSafeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function parseExpectedPositiveInteger(value, label) {
  if (typeof value === "number") {
    return requirePositiveSafeInteger(value, label);
  }
  if (typeof value !== "string" || !positiveIntegerPattern.test(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return requirePositiveSafeInteger(Number(value), label);
}

function isCanonicalPositiveIdUrl(value, prefix) {
  if (typeof value !== "string" || !value.startsWith(`${prefix}/`)) {
    return false;
  }
  const renderedId = value.slice(prefix.length + 1);
  return (
    positiveIntegerPattern.test(renderedId) &&
    Number.isSafeInteger(Number(renderedId))
  );
}

function requireTimestamp(value, label) {
  requireString(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} is malformed.`);
  }
  return timestamp;
}

function assertPullRequestTuple(pullRequest, expected, label) {
  if (
    pullRequest?.number !== expected.pullRequestNumber ||
    pullRequest.head?.ref !== expected.branch ||
    pullRequest.head?.sha !== expected.headSha ||
    pullRequest.base?.ref !== "main" ||
    pullRequest.base?.sha !== expected.baseSha
  ) {
    throw new Error(`${label} pull request provenance differs.`);
  }
}

function assertIndependentPullRequest(pullRequest, expected) {
  assertPullRequestTuple(pullRequest, expected, "Independent release pull request");
  if (
    pullRequest?.state !== "open" ||
    pullRequest.head?.repo?.full_name !== expected.repository ||
    pullRequest.base?.repo?.full_name !== expected.repository
  ) {
    throw new Error("Independent release pull request identity differs.");
  }
}

function assertRunPullRequestAssociation(pullRequests, expected) {
  if (!Array.isArray(pullRequests) || pullRequests.length > 1) {
    throw new Error("CodeQL workflow run pull request association is malformed.");
  }
  if (pullRequests.length === 1) {
    assertPullRequestTuple(pullRequests[0], expected, "CodeQL workflow run");
  }
}

function normalizedExpected(expected) {
  return Object.freeze({
    apiUrl: requireString(expected.apiUrl, "API URL").replace(/\/$/u, ""),
    repository: requireString(expected.repository, "Repository"),
    serverUrl: requireString(expected.serverUrl, "Server URL").replace(/\/$/u, ""),
    branch: requireString(expected.branch, "Release branch"),
    baseSha: requireString(expected.baseSha, "Release base SHA", exactShaPattern),
    headSha: requireString(expected.headSha, "Release head SHA", exactShaPattern),
    pullRequestNumber: parseExpectedPositiveInteger(
      expected.pullRequestNumber,
      "Pull request number",
    ),
    runId: parseExpectedPositiveInteger(expected.runId, "CodeQL run ID"),
  });
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function exactEntries(entries, predicate, label, validateEntry) {
  if (!Array.isArray(entries)) {
    throw new Error(`${label} response is malformed.`);
  }
  for (const [index, entry] of entries.entries()) {
    validateEntry(entry, `${label} entry ${index}`);
  }
  const matches = entries.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one matching entry.`);
  }
  return matches[0];
}

function validateRun(run, expected) {
  const expectedRunUrl =
    `${expected.serverUrl}/${expected.repository}/actions/runs/${expected.runId}`;
  const expectedRunApiUrl =
    `${expected.apiUrl}/repos/${expected.repository}/actions/runs/${expected.runId}`;
  if (
    run?.id !== expected.runId ||
    run.path !== ".github/workflows/codeql.yml" ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== expected.branch ||
    run.head_sha !== expected.headSha ||
    run.run_attempt !== 1 ||
    run.url !== expectedRunApiUrl ||
    run.html_url !== expectedRunUrl ||
    run.jobs_url !== `${expectedRunApiUrl}/jobs` ||
    run.rerun_url !== `${expectedRunApiUrl}/rerun` ||
    run.head_repository?.full_name !== expected.repository ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error("CodeQL workflow run identity differs.");
  }
  assertRunPullRequestAssociation(run.pull_requests, expected);
  return { expectedRunApiUrl, expectedRunUrl };
}

function validateAnalyze(jobs, expected, runUrls) {
  const jobUrlPrefix =
    `${expected.apiUrl}/repos/${expected.repository}/actions/jobs`;
  const checkRunUrlPrefix =
    `${expected.apiUrl}/repos/${expected.repository}/check-runs`;
  const analyze = exactEntries(
    jobs?.jobs,
    (job) => job?.name === "analyze",
    "CodeQL jobs",
    (job, label) => {
      requireObject(job, label);
      const jobId = requirePositiveSafeInteger(job.id, `${label} ID`);
      requireString(job.name, `${label} name`);
      requirePositiveSafeInteger(job.run_id, `${label} run ID`);
      requirePositiveSafeInteger(job.run_attempt, `${label} run attempt`);
      requireString(job.head_sha, `${label} head SHA`, exactShaPattern);
      if (
        job.url !== `${jobUrlPrefix}/${jobId}` ||
        job.html_url !== `${runUrls.expectedRunUrl}/job/${jobId}` ||
        job.run_url !== runUrls.expectedRunApiUrl ||
        !isCanonicalPositiveIdUrl(job.check_run_url, checkRunUrlPrefix)
      ) {
        throw new Error(`${label} identity differs.`);
      }
    },
  );
  const analyzeId = requirePositiveSafeInteger(analyze.id, "Analyze job ID");
  const expectedJobApiUrl =
    `${expected.apiUrl}/repos/${expected.repository}/actions/jobs/${analyzeId}`;
  const expectedJobUrl = `${runUrls.expectedRunUrl}/job/${analyzeId}`;
  const analyzeCheckId = isCanonicalPositiveIdUrl(
    analyze.check_run_url,
    checkRunUrlPrefix,
  )
    ? requirePositiveSafeInteger(
      Number(analyze.check_run_url.slice(checkRunUrlPrefix.length + 1)),
      "Analyze check ID",
    )
    : undefined;
  if (
    analyze.run_id !== expected.runId ||
    analyze.run_attempt !== 1 ||
    analyze.head_sha !== expected.headSha ||
    analyze.url !== expectedJobApiUrl ||
    analyze.html_url !== expectedJobUrl ||
    analyze.run_url !== runUrls.expectedRunApiUrl ||
    analyzeCheckId === undefined ||
    analyze.status !== "completed" ||
    analyze.conclusion !== "success"
  ) {
    throw new Error("CodeQL analyze job identity differs.");
  }
  const analyzeStartedAt = requireTimestamp(
    analyze.started_at,
    "Analyze start time",
  );
  const analyzeCompletedAt = requireTimestamp(
    analyze.completed_at,
    "Analyze completion time",
  );
  if (analyzeStartedAt > analyzeCompletedAt) {
    throw new Error("CodeQL analyze job timestamps are inverted.");
  }
  return {
    analyzeCheckId,
    analyzeCompletedAt,
    analyzeId,
    analyzeJobUrl: expectedJobUrl,
    analyzeStartedAt,
  };
}

function validateAnalyzeCheck(analyzeCheck, expected, analyzeWindow) {
  requireObject(analyzeCheck, "Analyze check run");
  const analyzeCheckSuiteId = requirePositiveSafeInteger(
    analyzeCheck.check_suite?.id,
    "Analyze check suite ID",
  );
  if (
    analyzeCheck.id !== analyzeWindow.analyzeCheckId ||
    analyzeCheck.id !== analyzeWindow.analyzeId ||
    analyzeCheck.url !==
      `${expected.apiUrl}/repos/${expected.repository}/check-runs/${analyzeWindow.analyzeCheckId}` ||
    analyzeCheck.html_url !== analyzeWindow.analyzeJobUrl ||
    analyzeCheck.name !== "analyze" ||
    analyzeCheck.app?.id !== 15368 ||
    analyzeCheck.head_sha !== expected.headSha ||
    analyzeCheck.details_url !== analyzeWindow.analyzeJobUrl ||
    analyzeCheck.status !== "completed" ||
    analyzeCheck.conclusion !== "success"
  ) {
    throw new Error("CodeQL analyze check run identity differs.");
  }
  return { analyzeCheckSuiteId };
}

function validateCheck(checkRuns, expected, analyzeWindow, analysisCreatedAt) {
  const codeqlCheck = exactEntries(
    checkRuns?.check_runs,
    (check) => check?.name === "CodeQL" && check.app?.id === 57789,
    "CodeQL check runs",
    (check, label) => {
      requireObject(check, label);
      const checkId = requirePositiveSafeInteger(check.id, `${label} ID`);
      requireString(check.name, `${label} name`);
      requireObject(check.app, `${label} app`);
      requirePositiveSafeInteger(check.app.id, `${label} app ID`);
      requireObject(check.check_suite, `${label} check suite`);
      requirePositiveSafeInteger(
        check.check_suite.id,
        `${label} check suite ID`,
      );
      requireString(check.head_sha, `${label} head SHA`, exactShaPattern);
      requireString(check.html_url, `${label} HTML URL`);
      requireString(check.details_url, `${label} details URL`);
      if (
        check.url !==
          `${expected.apiUrl}/repos/${expected.repository}/check-runs/${checkId}`
      ) {
        throw new Error(`${label} identity differs.`);
      }
    },
  );
  const checkId = requirePositiveSafeInteger(codeqlCheck.id, "CodeQL check ID");
  const checkSuiteId = requirePositiveSafeInteger(
    codeqlCheck.check_suite?.id,
    "CodeQL check suite ID",
  );
  if (
    codeqlCheck.head_sha !== expected.headSha ||
    codeqlCheck.url !==
      `${expected.apiUrl}/repos/${expected.repository}/check-runs/${checkId}` ||
    codeqlCheck.html_url !== `${expected.serverUrl}/${expected.repository}/runs/${checkId}` ||
    codeqlCheck.status !== "completed" ||
    codeqlCheck.conclusion !== "success" ||
    codeqlCheck.details_url !== `${expected.serverUrl}/${expected.repository}/runs/${checkId}`
  ) {
    throw new Error("GitHub Advanced Security CodeQL check identity differs.");
  }
  const checkStartedAt = requireTimestamp(codeqlCheck.started_at, "CodeQL check start time");
  const checkCompletedAt = requireTimestamp(
    codeqlCheck.completed_at,
    "CodeQL check completion time",
  );
  const processingDeadline = analyzeWindow.analyzeCompletedAt + 5 * 60 * 1000;
  if (
    checkStartedAt < analyzeWindow.analyzeStartedAt ||
    checkCompletedAt > processingDeadline ||
    Math.abs(checkStartedAt - analysisCreatedAt) > 5 * 60 * 1000 ||
    checkStartedAt > checkCompletedAt
  ) {
    throw new Error(
      "GitHub Advanced Security check is outside the dispatched analyze job.",
    );
  }
  return { checkCompletedAt, checkId, checkStartedAt, checkSuiteId };
}

function validateSuite(
  checkSuite,
  expected,
  analyzeWindow,
  analysisCreatedAt,
  checkSuiteId,
) {
  if (
    checkSuite?.id !== checkSuiteId ||
    checkSuite.url !==
      `${expected.apiUrl}/repos/${expected.repository}/check-suites/${checkSuiteId}` ||
    checkSuite.check_runs_url !==
      `${expected.apiUrl}/repos/${expected.repository}/check-suites/${checkSuiteId}/check-runs` ||
    checkSuite.head_sha !== expected.headSha ||
    checkSuite.head_branch !== expected.branch ||
    checkSuite.app?.id !== 57789 ||
    checkSuite.status !== "completed" ||
    checkSuite.conclusion !== "success"
  ) {
    throw new Error("GitHub Advanced Security check suite identity differs.");
  }
  if (!Array.isArray(checkSuite.pull_requests) || checkSuite.pull_requests.length !== 1) {
    throw new Error("CodeQL check suite must identify exactly one pull request.");
  }
  assertPullRequestTuple(checkSuite.pull_requests[0], expected, "CodeQL check suite");
  const suiteCreatedAt = requireTimestamp(
    checkSuite.created_at,
    "CodeQL suite creation time",
  );
  const suiteUpdatedAt = requireTimestamp(
    checkSuite.updated_at,
    "CodeQL suite update time",
  );
  const processingDeadline = analyzeWindow.analyzeCompletedAt + 5 * 60 * 1000;
  if (
    suiteCreatedAt < analyzeWindow.analyzeStartedAt ||
    suiteUpdatedAt > processingDeadline ||
    Math.abs(suiteCreatedAt - analysisCreatedAt) > 5 * 60 * 1000 ||
    suiteCreatedAt > suiteUpdatedAt
  ) {
    throw new Error("GitHub Advanced Security suite is outside the dispatched analyze job.");
  }
}

function validateAnalysis(analyses, expected, analyzeWindow) {
  const expectedRef = `refs/heads/${expected.branch}`;
  const expectedCategory = `release-attestation-${expected.runId}-1`;
  const analysis = exactEntries(
    analyses,
    (entry) =>
      entry?.ref === expectedRef &&
      entry.commit_sha === expected.headSha &&
      entry.analysis_key === ".github/workflows/codeql.yml:analyze" &&
      entry.category === expectedCategory &&
      entry.tool?.name === "CodeQL",
    "Code scanning analyses",
    (entry, label) => {
      requireObject(entry, label);
      const analysisId = requirePositiveSafeInteger(entry.id, `${label} ID`);
      requireString(entry.ref, `${label} ref`);
      requireString(entry.commit_sha, `${label} commit SHA`, exactShaPattern);
      requireString(entry.analysis_key, `${label} analysis key`);
      requireString(entry.category, `${label} category`);
      requireObject(entry.tool, `${label} tool`);
      requireString(entry.tool.name, `${label} tool name`);
      requireString(entry.sarif_id, `${label} SARIF ID`);
      requireTimestamp(entry.created_at, `${label} creation time`);
      if (
        entry.url !==
          `${expected.apiUrl}/repos/${expected.repository}/code-scanning/analyses/${analysisId}`
      ) {
        throw new Error(`${label} identity differs.`);
      }
    },
  );
  const analysisId = requirePositiveSafeInteger(
    analysis.id,
    "Code scanning analysis ID",
  );
  const analysisCreatedAt = requireTimestamp(
    analysis.created_at,
    "Code scanning analysis creation time",
  );
  const sarifId = requireString(
    analysis.sarif_id,
    "Code scanning SARIF ID",
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/u,
  );
  if (
    analysis.url !==
      `${expected.apiUrl}/repos/${expected.repository}/code-scanning/analyses/${analysisId}` ||
    analysis.environment !== "{}" ||
    analysis.warning !== "" ||
    analysisCreatedAt < analyzeWindow.analyzeStartedAt ||
    analysisCreatedAt > analyzeWindow.analyzeCompletedAt
  ) {
    throw new Error("Code scanning analysis is not bound to the exact CodeQL check.");
  }
  return { analysisCreatedAt, analysisId, sarifId };
}

export function validateReleaseCodeqlEvidence(payload, expected, priorReceipt) {
  const normalized = normalizedExpected(expected);
  const {
    run,
    jobs,
    analyses,
    analyzeCheck,
    checkRuns,
    checkSuite,
    pullRequest,
    postRun,
    postPullRequest,
  } = payload ?? {};
  assertIndependentPullRequest(pullRequest, normalized);
  const expectedRunUrl = validateRun(run, normalized);
  const analyze = validateAnalyze(jobs, normalized, expectedRunUrl);
  const analyzeCheckEvidence = validateAnalyzeCheck(
    analyzeCheck,
    normalized,
    analyze,
  );
  const analysis = validateAnalysis(analyses, normalized, analyze);
  const check = validateCheck(
    checkRuns,
    normalized,
    analyze,
    analysis.analysisCreatedAt,
  );
  validateSuite(
    checkSuite,
    normalized,
    analyze,
    analysis.analysisCreatedAt,
    check.checkSuiteId,
  );
  if (analyze.analyzeCheckId === check.checkId) {
    throw new Error(
      "CodeQL analyze and GitHub Advanced Security check identities must differ.",
    );
  }
  if (analyzeCheckEvidence.analyzeCheckSuiteId === check.checkSuiteId) {
    throw new Error(
      "CodeQL analyze and GitHub Advanced Security suite identities must differ.",
    );
  }

  const receipt = Object.freeze({
    analysisId: analysis.analysisId,
    analyzeCheckId: analyze.analyzeCheckId,
    analyzeCheckSuiteId: analyzeCheckEvidence.analyzeCheckSuiteId,
    analyzeId: analyze.analyzeId,
    checkId: check.checkId,
    checkSuiteId: check.checkSuiteId,
    runId: normalized.runId,
    sarifId: analysis.sarifId,
  });
  if (priorReceipt !== undefined) {
    validateRun(postRun, normalized);
    assertIndependentPullRequest(postPullRequest, normalized);
    for (const [name, value] of Object.entries(receipt)) {
      if (priorReceipt?.[name] !== value) {
        throw new Error(`Final CodeQL ${name} changed identity.`);
      }
    }
  }
  return receipt;
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      api: { type: "string" },
      branch: { type: "string" },
      head: { type: "string" },
      pr: { type: "string" },
      repository: { type: "string" },
      run: { type: "string" },
      server: { type: "string" },
    },
    strict: true,
  });
  const input = JSON.parse(await readStreamText(process.stdin));
  const receipt = validateReleaseCodeqlEvidence(input.evidence, {
    apiUrl: values.api,
    baseSha: values.base,
    branch: values.branch,
    headSha: values.head,
    pullRequestNumber: values.pr,
    repository: values.repository,
    runId: values.run,
    serverUrl: values.server,
  }, input.priorReceipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  await main();
}

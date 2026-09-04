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

function requirePositiveInteger(value, label) {
  const rendered = String(value);
  if (!positiveIntegerPattern.test(rendered)) {
    throw new Error(`${label} is malformed.`);
  }
  return Number(rendered);
}

function requireTimestamp(value, label) {
  requireString(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} is malformed.`);
  }
  return timestamp;
}

function assertPullRequest(pullRequests, expected, label) {
  if (!Array.isArray(pullRequests) || pullRequests.length !== 1) {
    throw new Error(`${label} must identify exactly one pull request.`);
  }
  const [pullRequest] = pullRequests;
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

function normalizedExpected(expected) {
  return Object.freeze({
    repository: requireString(expected.repository, "Repository"),
    serverUrl: requireString(expected.serverUrl, "Server URL").replace(/\/$/u, ""),
    branch: requireString(expected.branch, "Release branch"),
    baseSha: requireString(expected.baseSha, "Release base SHA", exactShaPattern),
    headSha: requireString(expected.headSha, "Release head SHA", exactShaPattern),
    pullRequestNumber: requirePositiveInteger(
      expected.pullRequestNumber,
      "Pull request number",
    ),
    runId: requirePositiveInteger(expected.runId, "CodeQL run ID"),
  });
}

function exactEntries(entries, predicate, label) {
  if (!Array.isArray(entries)) {
    throw new Error(`${label} response is malformed.`);
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
  if (
    run?.id !== expected.runId ||
    run.path !== ".github/workflows/codeql.yml" ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== expected.branch ||
    run.head_sha !== expected.headSha ||
    run.run_attempt !== 1 ||
    run.html_url !== expectedRunUrl ||
    run.head_repository?.full_name !== expected.repository ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error("CodeQL workflow run identity differs.");
  }
  assertPullRequest(run.pull_requests, expected, "CodeQL workflow run");
  return expectedRunUrl;
}

function validateAnalyze(jobs, expected, expectedRunUrl) {
  const analyze = exactEntries(
    jobs?.jobs,
    (job) => job?.name === "analyze",
    "CodeQL jobs",
  );
  const analyzeId = requirePositiveInteger(analyze.id, "Analyze job ID");
  const expectedJobUrl = `${expectedRunUrl}/job/${analyzeId}`;
  if (
    analyze.run_id !== expected.runId ||
    analyze.head_sha !== expected.headSha ||
    analyze.html_url !== expectedJobUrl ||
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
  return { analyzeCompletedAt, analyzeId, analyzeStartedAt };
}

function validateCheck(checkRuns, expected, analyzeWindow) {
  const codeqlCheck = exactEntries(
    checkRuns?.check_runs,
    (check) => check?.name === "CodeQL" && check.app?.id === 57789,
    "CodeQL check runs",
  );
  const checkId = requirePositiveInteger(codeqlCheck.id, "CodeQL check ID");
  const checkSuiteId = requirePositiveInteger(
    codeqlCheck.check_suite?.id,
    "CodeQL check suite ID",
  );
  if (
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
  if (
    checkStartedAt < analyzeWindow.analyzeStartedAt ||
    checkCompletedAt > analyzeWindow.analyzeCompletedAt ||
    checkStartedAt > checkCompletedAt
  ) {
    throw new Error(
      "GitHub Advanced Security check is outside the dispatched analyze job.",
    );
  }
  return { checkCompletedAt, checkId, checkStartedAt, checkSuiteId };
}

function validateSuite(checkSuite, expected, analyzeWindow, checkSuiteId) {
  if (
    checkSuite?.id !== checkSuiteId ||
    checkSuite.head_sha !== expected.headSha ||
    checkSuite.head_branch !== expected.branch ||
    checkSuite.app?.id !== 57789 ||
    checkSuite.status !== "completed" ||
    checkSuite.conclusion !== "success"
  ) {
    throw new Error("GitHub Advanced Security check suite identity differs.");
  }
  assertPullRequest(checkSuite.pull_requests, expected, "CodeQL check suite");
  const suiteCreatedAt = requireTimestamp(
    checkSuite.created_at,
    "CodeQL suite creation time",
  );
  const suiteUpdatedAt = requireTimestamp(
    checkSuite.updated_at,
    "CodeQL suite update time",
  );
  if (
    suiteCreatedAt < analyzeWindow.analyzeStartedAt ||
    suiteUpdatedAt > analyzeWindow.analyzeCompletedAt ||
    suiteCreatedAt > suiteUpdatedAt
  ) {
    throw new Error("GitHub Advanced Security suite is outside the dispatched analyze job.");
  }
}

function validateAnalysis(analyses, expected, checkWindow) {
  const expectedRef = `refs/heads/${expected.branch}`;
  const analysis = exactEntries(
    analyses,
    (entry) =>
      entry?.ref === expectedRef &&
      entry.commit_sha === expected.headSha &&
      entry.analysis_key === ".github/workflows/codeql.yml:analyze" &&
      entry.category === ".github/workflows/codeql.yml:analyze" &&
      entry.tool?.name === "CodeQL",
    "Code scanning analyses",
  );
  const analysisId = requirePositiveInteger(analysis.id, "Code scanning analysis ID");
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
    analysis.environment !== "{}" ||
    analysis.warning !== "" ||
    analysisCreatedAt < checkWindow.checkStartedAt ||
    analysisCreatedAt > checkWindow.checkCompletedAt
  ) {
    throw new Error("Code scanning analysis is not bound to the exact CodeQL check.");
  }
  return { analysisId, sarifId };
}

export function validateReleaseCodeqlEvidence(payload, expected, priorReceipt) {
  const normalized = normalizedExpected(expected);
  const { run, jobs, analyses, checkRuns, checkSuite } = payload ?? {};
  const expectedRunUrl = validateRun(run, normalized);
  const analyze = validateAnalyze(jobs, normalized, expectedRunUrl);
  const check = validateCheck(checkRuns, normalized, analyze);
  validateSuite(checkSuite, normalized, analyze, check.checkSuiteId);
  const analysis = validateAnalysis(analyses, normalized, check);

  const receipt = Object.freeze({
    analysisId: analysis.analysisId,
    analyzeId: analyze.analyzeId,
    checkId: check.checkId,
    checkSuiteId: check.checkSuiteId,
    runId: normalized.runId,
    sarifId: analysis.sarifId,
  });
  if (priorReceipt !== undefined) {
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

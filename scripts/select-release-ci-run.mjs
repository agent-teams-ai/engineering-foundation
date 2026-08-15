import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readStreamText } from "./check-release-pr-files.mjs";

const shaPattern = /^[0-9a-f]{40}$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;

function requireString(value, name, pattern = /\S/u) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is malformed.`);
  }
  return value;
}

function requirePullRequestNumber(value) {
  const rendered = String(value);
  if (!positiveIntegerPattern.test(rendered)) {
    throw new Error("Pull request number is malformed.");
  }
  return Number(rendered);
}

function matchesReleaseCiRun(run, expected) {
  if (!run || !Number.isSafeInteger(run.id) || run.id < 1) {
    return false;
  }
  const expectedUrl = `${expected.serverUrl}/${expected.repository}/actions/runs/${run.id}`;
  const runMatches = [
    run.path === ".github/workflows/ci.yml",
    run.event === "pull_request",
    run.head_branch === expected.branch,
    run.head_sha === expected.headSha,
    run.run_attempt === 1,
    run.conclusion !== "action_required",
    run.html_url === expectedUrl,
    run.head_repository?.full_name === expected.repository,
    Array.isArray(run.pull_requests),
    run.pull_requests?.length === 1,
  ].every(Boolean);
  if (!runMatches) {
    return false;
  }
  const [pullRequest] = run.pull_requests;
  return [
    pullRequest?.number === expected.pullRequestNumber,
    pullRequest.head?.ref === expected.branch,
    pullRequest.head?.sha === expected.headSha,
    pullRequest.base?.ref === "main",
    pullRequest.base?.sha === expected.baseSha,
  ].every(Boolean);
}

export function selectReleaseCiRun(payload, expected) {
  const normalizedExpected = {
    repository: requireString(expected.repository, "Repository"),
    serverUrl: requireString(expected.serverUrl, "Server URL").replace(/\/$/u, ""),
    branch: requireString(expected.branch, "Release branch"),
    baseSha: requireString(expected.baseSha, "Release base SHA", shaPattern),
    headSha: requireString(expected.headSha, "Release head SHA", shaPattern),
    pullRequestNumber: requirePullRequestNumber(expected.pullRequestNumber),
  };
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    throw new Error("Workflow run response is malformed.");
  }

  const matches = payload.workflow_runs.filter((run) =>
    matchesReleaseCiRun(run, normalizedExpected),
  );

  if (matches.length > 1) {
    throw new Error("Multiple exact attempt-1 pull request CI runs were found.");
  }
  const [match] = matches;
  return match ? { id: match.id, event: match.event, url: match.html_url } : null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      branch: { type: "string" },
      head: { type: "string" },
      pr: { type: "string" },
      repository: { type: "string" },
      server: { type: "string" },
    },
    strict: true,
  });
  const payload = JSON.parse(await readStreamText(process.stdin));
  const selected = selectReleaseCiRun(payload, {
    baseSha: values.base,
    branch: values.branch,
    headSha: values.head,
    pullRequestNumber: values.pr,
    repository: values.repository,
    serverUrl: values.server,
  });
  process.stdout.write(`${JSON.stringify(selected)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  await main();
}

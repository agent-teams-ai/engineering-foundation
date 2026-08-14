import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function requireString(value, label) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be non-empty`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}

function instant(value, label) {
  const milliseconds = Date.parse(requireString(value, label));
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return milliseconds;
}

function duration(startedAt, completedAt) {
  if (startedAt === null || completedAt === null) {
    return null;
  }
  const value = instant(completedAt, "completed_at") - instant(startedAt, "started_at");
  if (value < 0) {
    throw new Error("completed_at precedes started_at");
  }
  return value;
}

function topologyFingerprint(jobs) {
  const topology = jobs
    .map((job) => ({ labels: [...job.labels].toSorted(), name: job.name }))
    .toSorted((left, right) => left.name.localeCompare(right.name, "en"));
  return `sha256:${createHash("sha256").update(JSON.stringify(topology)).digest("hex")}`;
}

function markdownCell(value) {
  return String(value)
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

export function buildCiSignalArtifact({ sourceRun, jobs, relevance }) {
  requirePositiveInteger(sourceRun.id, "source run id");
  requirePositiveInteger(sourceRun.run_attempt, "source run attempt");
  if (!/^[a-f0-9]{40}$/u.test(requireString(sourceRun.head_sha, "head SHA"))) {
    throw new Error("head SHA must be a full lowercase Git commit SHA");
  }
  const normalizedJobs = jobs.map((job) => {
    const name = requireString(job.name, "job name");
    const labels = Array.isArray(job.labels) && job.labels.every((label) => typeof label === "string")
      ? [...job.labels]
      : [];
    return {
      id: requirePositiveInteger(job.id, `${name} id`),
      name,
      conclusion: job.conclusion ?? null,
      status: requireString(job.status, `${name} status`),
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      durationMilliseconds: duration(job.started_at ?? null, job.completed_at ?? null),
      labels,
    };
  }).toSorted((left, right) => left.name.localeCompare(right.name, "en"));
  if (new Set(normalizedJobs.map(({ name }) => name)).size !== normalizedJobs.length) {
    throw new Error("source run contains duplicate job names");
  }
  return {
    schemaVersion: 1,
    advisory: true,
    generatedAt: new Date().toISOString(),
    source: {
      repository: requireString(sourceRun.repository.full_name, "repository"),
      workflowPath: requireString(sourceRun.path, "workflow path"),
      runId: sourceRun.id,
      runAttempt: sourceRun.run_attempt,
      event: requireString(sourceRun.event, "source event"),
      conclusion: sourceRun.conclusion ?? null,
      headSha: sourceRun.head_sha,
      headBranch: sourceRun.head_branch ?? null,
      createdAt: requireString(sourceRun.created_at, "source created_at"),
      runStartedAt: requireString(sourceRun.run_started_at, "source run_started_at"),
      updatedAt: requireString(sourceRun.updated_at, "source updated_at"),
      wallMilliseconds: duration(sourceRun.run_started_at, sourceRun.updated_at),
      htmlUrl: requireString(sourceRun.html_url, "source html_url"),
    },
    relevance,
    topologyFingerprint: topologyFingerprint(normalizedJobs),
    jobs: normalizedJobs,
  };
}

export function renderCiSignalSummary(artifact) {
  const slowest = artifact.jobs
    .filter(({ durationMilliseconds }) => durationMilliseconds !== null)
    .toSorted((left, right) => right.durationMilliseconds - left.durationMilliseconds)
    .slice(0, 12);
  const rows = slowest.map((job) =>
    `| ${markdownCell(job.name)} | ${markdownCell(job.conclusion ?? job.status)} | ${(job.durationMilliseconds / 60_000).toFixed(2)} min |`,
  );
  return [
    "## CI feedback",
    "",
    `Source: [run ${artifact.source.runId}, attempt ${artifact.source.runAttempt}](${artifact.source.htmlUrl}) at \`${artifact.source.headSha.slice(0, 12)}\``,
    `Relevance: **${artifact.relevance.status}**. Timings are advisory and never block a pull request.`,
    `Wall time: **${(artifact.source.wallMilliseconds / 60_000).toFixed(2)} min**`,
    "",
    "| Slowest lanes | Result | Duration |",
    "|---|---|---:|",
    ...rows,
    "",
    `Topology: \`${artifact.topologyFingerprint}\``,
    "",
  ].join("\n");
}

function outputArgument(arguments_) {
  const index = arguments_.findIndex((argument) => argument === "--output");
  if (index === -1 || arguments_[index + 1] === undefined) {
    throw new Error("Usage: node scripts/ci-feedback.mjs --output <path>");
  }
  return resolve(arguments_[index + 1]);
}

async function githubJson(path, token, apiUrl) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} returned ${response.status}`);
  }
  return response.json();
}

export async function sourceRelevance(sourceRun, token, apiUrl, request = githubJson) {
  const headRepository = sourceRun.head_repository?.full_name;
  if (sourceRun.event === "pull_request" && (typeof headRepository !== "string" || headRepository === "")) {
    return { status: "unresolved", pullRequest: null };
  }
  let pullRequests = Array.isArray(sourceRun.pull_requests) ? sourceRun.pull_requests : [];
  if (pullRequests.length === 0 && sourceRun.event === "pull_request") {
    const response = await request(
      `/repos/${sourceRun.repository.full_name}/commits/${sourceRun.head_sha}/pulls?per_page=10`,
      token,
      apiUrl,
    );
    pullRequests = Array.isArray(response)
      ? response.filter((pullRequest) =>
        pullRequest.head?.sha === sourceRun.head_sha &&
        pullRequest.head?.repo?.full_name === headRepository)
      : [];
  }
  if (pullRequests.length !== 1) {
    return { status: sourceRun.event === "push" ? "main-or-branch" : "unresolved", pullRequest: null };
  }
  const number = requirePositiveInteger(pullRequests[0].number, "pull request number");
  const pullRequest = await request(`/repos/${sourceRun.repository.full_name}/pulls/${number}`, token, apiUrl);
  const current =
    pullRequest.state === "open" &&
    pullRequest.head?.sha === sourceRun.head_sha &&
    pullRequest.head?.repo?.full_name === headRepository;
  return { status: current ? "current" : "superseded", pullRequest: number };
}

async function run() {
  const event = JSON.parse(await readFile(requireString(process.env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH"), "utf8"));
  const eventRun = event.workflow_run;
  if (event.action !== "completed" || eventRun?.status !== "completed") {
    throw new Error("CI feedback accepts only completed workflow_run events");
  }
  const repository = requireString(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const token = requireString(process.env.GH_TOKEN, "GH_TOKEN");
  const apiUrl = requireString(process.env.GITHUB_API_URL, "GITHUB_API_URL");
  const runId = requirePositiveInteger(eventRun.id, "event run id");
  const sourceRun = await githubJson(`/repos/${repository}/actions/runs/${runId}`, token, apiUrl);
  if (
    sourceRun.id !== runId ||
    sourceRun.repository?.full_name !== repository ||
    sourceRun.path !== ".github/workflows/ci.yml" ||
    sourceRun.head_sha !== eventRun.head_sha ||
    sourceRun.run_attempt !== eventRun.run_attempt ||
    !Number.isFinite(Date.parse(sourceRun.run_started_at)) ||
    sourceRun.status !== "completed"
  ) {
    throw new Error("Refetched source run does not exactly match the workflow_run event");
  }
  const jobsResponse = await githubJson(
    `/repos/${repository}/actions/runs/${runId}/attempts/${sourceRun.run_attempt}/jobs?per_page=100`,
    token,
    apiUrl,
  );
  if (!Array.isArray(jobsResponse.jobs) || jobsResponse.total_count !== jobsResponse.jobs.length) {
    throw new Error("CI feedback refuses incomplete or paginated job evidence");
  }
  if (jobsResponse.jobs.some((job) => job.run_attempt !== sourceRun.run_attempt)) {
    throw new Error("CI feedback refuses jobs from a different run attempt");
  }
  const artifact = buildCiSignalArtifact({
    sourceRun,
    jobs: jobsResponse.jobs,
    relevance: await sourceRelevance(sourceRun, token, apiUrl),
  });
  await writeFile(outputArgument(process.argv.slice(2)), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, renderCiSignalSummary(artifact), "utf8");
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await run();
}

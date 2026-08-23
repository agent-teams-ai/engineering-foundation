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

const githubInstantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

function instant(value, label) {
  const match = githubInstantPattern.exec(requireString(value, label));
  if (match === null) {
    throw new Error(`${label} must be a GitHub UTC ISO-8601 instant`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(`${label} must be a GitHub UTC ISO-8601 instant`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be a GitHub UTC ISO-8601 instant`);
  }
  return milliseconds;
}

function isInstant(value) {
  try {
    instant(value, "timestamp");
    return true;
  } catch {
    return false;
  }
}

function duration(startedAt, completedAt) {
  const start = startedAt === null ? null : instant(startedAt, "started_at");
  const end = completedAt === null ? null : instant(completedAt, "completed_at");
  if (start === null || end === null) {
    return { anomaly: null, milliseconds: null };
  }
  const value = end - start;
  if (value < 0) {
    return { anomaly: "end-precedes-start", milliseconds: null };
  }
  return { anomaly: null, milliseconds: value };
}

function topologyFingerprint(jobs) {
  const topology = jobs
    .map((job) => ({ labels: [...job.labels].toSorted(), name: job.name }))
    .toSorted((left, right) => left.name.localeCompare(right.name, "en"));
  return `sha256:${createHash("sha256").update(JSON.stringify(topology)).digest("hex")}`;
}

function markdownCodeCell(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("!", "&#33;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("(", "&#40;")
    .replaceAll(")", "&#41;")
    .replaceAll("|", "&#124;")
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
    const measuredDuration = duration(job.started_at ?? null, job.completed_at ?? null);
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
      durationMilliseconds: measuredDuration.milliseconds,
      timingAnomaly: measuredDuration.anomaly,
      labels,
    };
  }).toSorted((left, right) => left.name.localeCompare(right.name, "en"));
  if (new Set(normalizedJobs.map(({ name }) => name)).size !== normalizedJobs.length) {
    throw new Error("source run contains duplicate job names");
  }
  const createdAt = requireString(sourceRun.created_at, "source created_at");
  instant(createdAt, "source created_at");
  const measuredWallDuration = duration(sourceRun.run_started_at, sourceRun.updated_at);
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
      createdAt,
      runStartedAt: requireString(sourceRun.run_started_at, "source run_started_at"),
      updatedAt: requireString(sourceRun.updated_at, "source updated_at"),
      wallMilliseconds: measuredWallDuration.milliseconds,
      timingAnomaly: measuredWallDuration.anomaly,
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
    `| <code>${markdownCodeCell(job.name)}</code> | <code>${markdownCodeCell(job.conclusion ?? job.status)}</code> | ${(job.durationMilliseconds / 60_000).toFixed(2)} min |`,
  );
  const timingAnomalies = [
    artifact.source.timingAnomaly,
    ...artifact.jobs.map(({ timingAnomaly }) => timingAnomaly),
  ].filter((anomaly) => typeof anomaly === "string");
  const anomalyCodes = [...new Set(timingAnomalies)].toSorted();
  const wallTime = artifact.source.wallMilliseconds === null
    ? "unavailable"
    : `${(artifact.source.wallMilliseconds / 60_000).toFixed(2)} min`;
  return [
    "## CI feedback",
    "",
    `Source: [run ${artifact.source.runId}, attempt ${artifact.source.runAttempt}](${artifact.source.htmlUrl}) at \`${artifact.source.headSha.slice(0, 12)}\``,
    `Relevance: **${artifact.relevance.status}**. Timings are advisory and never block a pull request.`,
    `Wall time: **${wallTime}**`,
    ...(timingAnomalies.length === 0
      ? []
      : [`Timing anomalies: **${timingAnomalies.length}** (${anomalyCodes.map((code) => `\`${code}\``).join(", ")}). Affected durations are unavailable.`]),
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

async function githubResponse(path, token, apiUrl) {
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
  return response;
}

async function githubJson(path, token, apiUrl) {
  return (await githubResponse(path, token, apiUrl)).json();
}

async function githubJsonPage(path, token, apiUrl) {
  const response = await githubResponse(path, token, apiUrl);
  const link = response.headers.get("link") ?? "";
  return {
    data: await response.json(),
    hasNextPage: link.split(",").some((part) => /;\s*rel="next"/u.test(part)),
  };
}

const pullRequestResolutionEvents = new Set(["pull_request", "workflow_dispatch"]);

function fallbackPageRequest(request) {
  if (request === githubJson) {
    return githubJsonPage;
  }
  return async (...arguments_) => ({ data: await request(...arguments_), hasNextPage: false });
}

async function associatedPullRequests(sourceRun, token, apiUrl, request, pageRequest) {
  let pullRequests = Array.isArray(sourceRun.pull_requests) ? sourceRun.pull_requests : [];
  if (pullRequests.length !== 0 || !pullRequestResolutionEvents.has(sourceRun.event)) {
    return pullRequests;
  }
  const page = await pageRequest(
    `/repos/${sourceRun.repository.full_name}/commits/${sourceRun.head_sha}/pulls?per_page=100`,
    token,
    apiUrl,
  );
  if (page.hasNextPage) {
    return null;
  }
  const headRepository = sourceRun.head_repository.full_name;
  pullRequests = Array.isArray(page.data)
    ? page.data.filter((pullRequest) =>
      pullRequest.head?.sha === sourceRun.head_sha &&
      pullRequest.head?.repo?.full_name === headRepository)
    : [];
  return pullRequests;
}

export async function sourceRelevance(sourceRun, token, apiUrl, request = githubJson, pageRequest) {
  const resolvesPullRequest = pullRequestResolutionEvents.has(sourceRun.event);
  const headRepository = sourceRun.head_repository?.full_name;
  if (resolvesPullRequest && (typeof headRepository !== "string" || headRepository === "")) {
    return { status: "unresolved", pullRequest: null };
  }
  const pullRequests = await associatedPullRequests(
    sourceRun,
    token,
    apiUrl,
    request,
    pageRequest ?? fallbackPageRequest(request),
  );
  if (pullRequests === null) {
    return { status: "unresolved", pullRequest: null };
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

export function workflowRunAttemptPath(repository, runId, runAttempt) {
  return `/repos/${requireString(repository, "repository")}/actions/runs/${requirePositiveInteger(runId, "run id")}/attempts/${requirePositiveInteger(runAttempt, "run attempt")}`;
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
  const runAttempt = requirePositiveInteger(eventRun.run_attempt, "event run attempt");
  const sourceRun = await githubJson(workflowRunAttemptPath(repository, runId, runAttempt), token, apiUrl);
  if (
    sourceRun.id !== runId ||
    sourceRun.repository?.full_name !== repository ||
    sourceRun.path !== ".github/workflows/ci.yml" ||
    sourceRun.head_sha !== eventRun.head_sha ||
    sourceRun.run_attempt !== runAttempt ||
    !isInstant(sourceRun.run_started_at) ||
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

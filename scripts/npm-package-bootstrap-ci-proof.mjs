import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proof that the exact commit to bootstrap passed the repository's full CI. It reads only the jobs of one `ci.yml` workflow
// run that GitHub Actions itself created for a push of this commit to main: a check run with the same name from another app
// is never read, so it cannot count. It never waits: no run, a running run or a red context is an error.
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
// The same contexts as `ci_contexts` in release.yml, which a test keeps equal.
export const CI_CONTEXTS = Object.freeze(["check", "windows-check", "macos-qualification", "full-ci"]);
export const CI_PROOF_CONTEXTS = Object.freeze([...CI_CONTEXTS, "linux-package"]);

const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAXIMUM_JOBS = 300;

export class CiProofError extends Error {
  constructor(code, message) {
    super(`CI proof refused (${code}): ${message}`);
    this.name = "CiProofError";
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new CiProofError(code, message);
};

function list(value, key, label) {
  const items = value?.[key];
  if (!Array.isArray(items)) {refuse("CI_PROOF_MALFORMED", `${label} has no ${key} array.`);}
  return items;
}

function selectRun(runs, { commit, repository }) {
  const matching = runs.filter((run) =>
    run?.head_sha === commit && run.event === "push" && run.head_branch === "main" &&
    run.path === CI_WORKFLOW_PATH && run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository);
  if (matching.length === 0) {refuse("CI_PROOF_NO_RUN", `no push run of ${CI_WORKFLOW_PATH} on main for ${commit}.`);}
  if (matching.length > 1) {refuse("CI_PROOF_AMBIGUOUS", `${matching.length} push runs of ${CI_WORKFLOW_PATH} for ${commit}.`);}
  const [run] = matching;
  if (!Number.isSafeInteger(run.id) || run.id <= 0) {refuse("CI_PROOF_MALFORMED", "the run has no valid id.");}
  if (run.status !== "completed") {refuse("CI_PROOF_PENDING", `run ${String(run.id)} is ${String(run.status)}.`);}
  if (run.conclusion !== "success") {refuse("CI_PROOF_NOT_GREEN", `run ${String(run.id)} concluded ${String(run.conclusion)}.`);}
  return run;
}

function checkContexts(jobs, run, commit) {
  for (const context of CI_PROOF_CONTEXTS) {
    const named = jobs.filter((job) => job?.name === context);
    if (named.length === 0) {refuse("CI_PROOF_CONTEXT_MISSING", `run ${String(run.id)} has no job ${context}.`);}
    if (named.length > 1) {refuse("CI_PROOF_AMBIGUOUS", `run ${String(run.id)} has ${named.length} jobs named ${context}.`);}
    const [job] = named;
    if (job.run_id !== run.id || job.head_sha !== commit) {
      refuse("CI_PROOF_MALFORMED", `job ${context} does not belong to run ${String(run.id)} at ${commit}.`);
    }
    if (job.status !== "completed" || job.conclusion !== "success") {
      refuse("CI_PROOF_CONTEXT_NOT_SUCCESS", `job ${context} is ${String(job.status)} / ${String(job.conclusion)}.`);
    }
  }
}

/**
 * @param {{ repository: string, commit: string, request: (path: string) => Promise<unknown> }} input
 * `request` answers a GitHub REST path with parsed JSON; only the two Actions run endpoints below are requested.
 */
export async function proveCommitCi({ repository, commit, request }) {
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {refuse("CI_PROOF_INPUT", "repository is malformed.");}
  if (typeof commit !== "string" || !SHA.test(commit)) {refuse("CI_PROOF_INPUT", "commit must be an exact 40-hex SHA.");}
  const base = `repos/${repository}/actions`;
  const runs = await request(`${base}/workflows/ci.yml/runs?head_sha=${commit}&event=push&branch=main&per_page=100`);
  const run = selectRun(list(runs, "workflow_runs", "the run listing"), { commit, repository });
  const jobs = await request(`${base}/runs/${String(run.id)}/jobs?filter=latest&per_page=100`);
  const items = list(jobs, "jobs", "the job listing");
  if (items.length > MAXIMUM_JOBS || jobs.total_count !== items.length) {
    refuse("CI_PROOF_MALFORMED", "the job listing is incomplete.");
  }
  checkContexts(items, run, commit);
  return Object.freeze({ runId: run.id, commit, contexts: CI_PROOF_CONTEXTS });
}

export function githubRequest(token, fetchImplementation = fetch) {
  return async (path) => {
    const response = await fetchImplementation(`https://api.github.com/${path}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {refuse("CI_PROOF_API", `GitHub answered ${String(response.status)} for ${path.split("?")[0]}.`);}
    return response.json();
  };
}

// Compare real paths: a symlinked checkout path (for example /tmp on macOS) must not turn the command into a silent no-op.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const token = process.env.GH_TOKEN;
    if (token === undefined || token === "") {refuse("CI_PROOF_INPUT", "GH_TOKEN is not set.");}
    const proof = await proveCommitCi({
      repository: process.env.GITHUB_REPOSITORY ?? "", commit: process.argv[2] ?? "", request: githubRequest(token),
    });
    process.stdout.write(`CI proof: run ${String(proof.runId)} at ${proof.commit} is green for ${proof.contexts.join(", ")}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

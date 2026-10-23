import {
  object,
  positive,
  json,
  snapshot,
  unchanged,
  boundRun,
  collection,
  type Repository,
  type Snapshot,
  type BoundRun,
} from "./request-full-pr-ci-metadata.ts";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const workflowPath = ".github/workflows/ci.yml";
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const readTimeout = 20_000;
const watchTimeout = 90 * 60_000;

// Private host IO boundary: tests supply metadata and record actual effect intent.
export interface FullCiPort {
  gh(args: readonly string[], timeoutMs: number): Promise<string>;
  delay(milliseconds: number): Promise<void>;
  // A fresh UUID per invocation; optional to preserve existing read-only ports.
  nonce?(): string;
}
interface Options {
  readonly pr: number;
  readonly wait: boolean;
}
export interface FullCiResult {
  readonly outcome: "ready" | "requested";
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly baseRef: string;
}

export function parseFullCiArguments(input: readonly string[]): Options {
  const args = input[0] === "--" ? input.slice(1) : input;
  if (
    args.length < 2 ||
    args.length > 3 ||
    args[0] !== "--pr" ||
    !/^[1-9][0-9]*$/u.test(args[1] ?? "") ||
    (args.length === 3 && args[2] !== "--wait")
  ) {
    throw new Error("Usage: pnpm ci:full -- --pr N [--wait]");
  }
  return { pr: positive(Number(args[1])), wait: args[2] === "--wait" };
}

async function latestRun(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
): Promise<BoundRun | undefined> {
  const entries = await collection(
    port,
    `repos/${repo.name}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head}`,
    "workflow_runs",
  );
  return entries
    .map((entry) => boundRun(entry, repo, pr))
    .filter((run): run is BoundRun => run !== undefined)
    .toSorted((a, b) => b.id - a.id)[0];
}
async function rereadRun(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
  expected: BoundRun,
): Promise<BoundRun> {
  const run = boundRun(
    await json(port, ["api", `repos/${repo.name}/actions/runs/${expected.id}`]),
    repo,
    pr,
  );
  if (!run || run.id !== expected.id || run.attempt !== expected.attempt) {
    throw new Error("Bound CI run identity/attempt changed");
  }
  return run;
}
async function successful(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
  run: BoundRun,
): Promise<boolean> {
  if (run.status !== "completed" || run.conclusion !== "success") {
    return false;
  }
  // Selective retries retain successful jobs from earlier attempts. The latest
  // filter supplies each effective job; the run detail bounds its attempt.
  const jobs = await collection(
    port,
    `repos/${repo.name}/actions/runs/${run.id}/jobs?filter=latest`,
    "jobs",
  );
  const records = jobs.map(object);
  return ["full-ci", "check", "windows-check", "macos-qualification"].every((name) => {
    const gates = records.filter((job) => job.name === name);
    if (gates.length !== 1) {
      return false;
    }
    const gate = gates[0]!;
    return (
      typeof gate.id === "number" &&
      Number.isSafeInteger(gate.id) &&
      gate.id > 0 &&
      records.filter((job) => job.id === gate.id).length === 1 &&
      gate.run_id === run.id &&
      gate.head_sha === pr.head &&
      typeof gate.run_attempt === "number" &&
      Number.isSafeInteger(gate.run_attempt) &&
      gate.run_attempt > 0 &&
      gate.run_attempt <= run.attempt &&
      gate.status === "completed" &&
      gate.conclusion === "success"
    );
  });
}
async function finish(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
  run: BoundRun,
  wait: boolean,
): Promise<FullCiResult> {
  let current = await rereadRun(port, repo, pr, run);
  if (wait && current.status !== "completed") {
    // A failed watch may have lost its final response. Only fresh API evidence decides.
    try {
      await port.gh(
        [
          "run",
          "watch",
          String(current.id),
          "--repo",
          repo.name,
          "--exit-status",
          "--interval",
          "10",
        ],
        watchTimeout,
      );
    } catch {
      /* Reconcile below. */
    }
    current = await rereadRun(port, repo, pr, current);
  }
  const ready = await successful(port, repo, pr, current);
  const newest = await latestRun(port, repo, pr);
  // The run-list endpoint can lag behind run detail during ordinary lifecycle
  // transitions. Detail and actual jobs prove success; the list binds newest identity.
  if (!newest || newest.id !== current.id || newest.attempt !== current.attempt) {
    throw new Error("Latest bound CI request changed; inspect Actions before retrying");
  }
  const confirmed = await rereadRun(port, repo, pr, current);
  if (confirmed.status !== current.status || confirmed.conclusion !== current.conclusion) {
    throw new Error("Bound CI run status/conclusion changed; inspect Actions before retrying");
  }
  await unchanged(port, repo, pr);
  if (!ready && (wait || current.status === "completed")) {
    throw new Error(`Full CI is not successful: ${current.url}`);
  }
  return {
    outcome: ready ? "ready" : "requested",
    url: current.url,
    head: pr.head,
    base: pr.base,
    baseRef: pr.baseRef,
  };
}

async function requireUser(port: FullCiPort): Promise<void> {
  try {
    const user = object(await json(port, ["api", "user"]));
    positive(user.id);
    if (
      user.type !== "User" ||
      typeof user.login !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(user.login)
    ) {
      throw new Error("Not a user credential");
    }
  } catch {
    throw new Error(
      "Full CI writes require a user-authenticated gh credential (GET /user with a valid User identity); GITHUB_TOKEN labeled events are suppressed",
    );
  }
}

function reservationName(repo: Repository, pr: Snapshot, retry?: BoundRun): string {
  // An ordered, versioned array avoids ambiguous concatenation. Labels and
  // lifecycle status are observations, not part of the frozen source binding.
  const binding = [
    "ci-full-v1",
    repo.id,
    repo.name,
    pr.number,
    pr.head,
    pr.base,
    pr.baseRef,
    pr.headRepo,
    pr.headRepoName,
    pr.headRef,
    pr.baseRepo,
    ...(retry ? ["rerun-failed", retry.id, retry.attempt] : ["request"]),
  ];
  return `ci:full:${createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 40)}`;
}

async function reserve(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
  retry?: BoundRun,
): Promise<{ name: string; owned: boolean }> {
  const nonce = port.nonce?.() ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(nonce)) {
    throw new Error("Malformed reservation owner UUID; no write attempted");
  }
  const name = reservationName(repo, pr, retry);
  const description = `ci-full:v1:pr:${pr.number}:owner:${nonce}`;
  await unchanged(port, repo, pr);
  try {
    // Creation is the atomic admission primitive. Never retry this write or
    // update/delete a label owned by another caller, even after a lost response.
    await port.gh(
      [
        "api",
        "--method",
        "POST",
        `repos/${repo.name}/labels`,
        "-f",
        `name=${name}`,
        "-f",
        "color=0e8a16",
        "-f",
        `description=${description}`,
      ],
      readTimeout,
    );
  } catch {
    /* Every outcome, including success, is reconciled by an exact read. */
  }
  let observed: Record<string, unknown>;
  try {
    observed = object(
      await json(port, ["api", `repos/${repo.name}/labels/${encodeURIComponent(name)}`]),
    );
  } catch {
    throw new Error(
      "Reservation creation effect uncertain: exact label ownership unavailable; inspect Actions and labels, then manually request ci:full if needed",
    );
  }
  if (observed.name !== name || typeof observed.description !== "string") {
    throw new Error(
      "Reservation ownership malformed; inspect Actions and labels before a manual ci:full request",
    );
  }
  return { name, owned: observed.description === description };
}

async function observeRequest(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
  wait: boolean,
): Promise<FullCiResult> {
  for (let observation = 0; observation < 12; observation += 1) {
    await unchanged(port, repo, pr);
    const run = await latestRun(port, repo, pr);
    if (run) {
      return finish(port, repo, pr, run, wait);
    }
    if (observation < 11) {
      await port.delay(5_000);
    }
  }
  throw new Error(
    "Request effect uncertain: reserved snapshot has no bound CI run; inspect Actions and labels before manually requesting ci:full; no automatic takeover or resubmission",
  );
}

async function retryDetail(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
  previous: BoundRun,
): Promise<BoundRun> {
  const current = boundRun(
    await json(port, ["api", `repos/${repo.name}/actions/runs/${previous.id}`]),
    repo,
    pr,
  );
  if (
    !current ||
    current.id !== previous.id ||
    current.attempt < previous.attempt ||
    current.attempt > previous.attempt + 1
  ) {
    throw new Error(
      "Bound CI retry identity/attempt changed beyond the expected next attempt; inspect Actions before retrying",
    );
  }
  const latest = await latestRun(port, repo, pr);
  if (
    !latest ||
    latest.id !== current.id ||
    latest.attempt < previous.attempt ||
    latest.attempt > previous.attempt + 1
  ) {
    throw new Error(
      "Latest bound CI request changed during retry; inspect Actions before retrying",
    );
  }
  return current;
}

async function observeRetry(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
  previous: BoundRun,
  wait: boolean,
): Promise<FullCiResult> {
  for (let observation = 0; observation < 12; observation += 1) {
    await unchanged(port, repo, pr);
    const current = await retryDetail(port, repo, pr, previous);
    if (current.attempt === previous.attempt + 1) {
      // finish pins this exact attempt before watch. A subsequent retry or
      // superseding request must reject, rather than silently qualify new work.
      const latest = await latestRun(port, repo, pr);
      if (latest?.id === current.id && latest.attempt === current.attempt) {
        return finish(port, repo, pr, current, wait);
      }
    }
    if (observation < 11) {
      await port.delay(5_000);
    }
  }
  throw new Error(
    "Retry effect uncertain: no bound next attempt observed; inspect Actions and retry reservation before manual recovery; no rerun resubmitted",
  );
}

async function retryFailed(
  port: FullCiPort,
  repo: Repository,
  pr: Snapshot,
  run: BoundRun,
  wait: boolean,
): Promise<FullCiResult> {
  await requireUser(port);
  const reservation = await reserve(port, repo, pr, run);
  if (reservation.owned) {
    const current = await retryDetail(port, repo, pr, run);
    await unchanged(port, repo, pr);
    if (current.attempt === run.attempt) {
      if (current.status !== run.status || current.conclusion !== run.conclusion) {
        throw new Error(
          "Bound CI run status/conclusion changed before retry; inspect Actions before retrying",
        );
      }
      try {
        await port.gh(
          ["run", "rerun", String(run.id), "--repo", repo.name, "--failed"],
          readTimeout,
        );
      } catch {
        /* An uncertain rerun is reconciled only by reading its next attempt. */
      }
    }
  }
  // Retry reservations are repository labels only: attaching one to the PR
  // would emit a second full-matrix request.
  return observeRetry(port, repo, pr, run, wait);
}

async function requestContext(
  args: readonly string[],
  port: FullCiPort,
): Promise<{ options: Options; repo: Repository; pr: Snapshot }> {
  const options = parseFullCiArguments(args); // Validate before any IO or mutation.
  const name = object(await json(port, ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  if (typeof name !== "string" || !repositoryName.test(name)) {
    throw new Error("Malformed repository name");
  }
  const metadata = object(await json(port, ["api", `repos/${name}`]));
  if (metadata.full_name !== name) {
    throw new Error("Repository identity changed");
  }
  const workflow = object(await json(port, ["api", `repos/${name}/actions/workflows/ci.yml`]));
  if (workflow.name !== "CI" || workflow.path !== workflowPath) {
    throw new Error("Canonical CI workflow identity changed");
  }
  const repo: Repository = { name, id: positive(metadata.id), workflowId: positive(workflow.id) };
  const pr = await snapshot(port, repo, options.pr);
  return { options, repo, pr };
}

// Gate consumers can inspect the same evidence without any request/retry
// admission, credential requirement, or label/rerun effect.
export async function readFullPrCi(
  args: readonly string[],
  port: FullCiPort,
): Promise<FullCiResult> {
  const { options, repo, pr } = await requestContext(args, port);
  const run = await latestRun(port, repo, pr);
  if (!run) {
    throw new Error("No exact bound full CI run; request qualification separately");
  }
  return finish(port, repo, pr, run, options.wait);
}

export async function requestFullPrCi(
  args: readonly string[],
  port: FullCiPort,
): Promise<FullCiResult> {
  const { options, repo, pr } = await requestContext(args, port);
  const discovered = await latestRun(port, repo, pr);
  const existing =
    discovered === undefined ? undefined : await rereadRun(port, repo, pr, discovered);
  if (existing) {
    if (existing.status !== "completed" || (await successful(port, repo, pr, existing))) {
      return finish(port, repo, pr, existing, options.wait);
    }
    if (
      ![
        "failure",
        "cancelled",
        "timed_out",
        "action_required",
        "startup_failure",
        "stale",
      ].includes(String(existing.conclusion))
    ) {
      throw new Error(
        `Full CI has unsuccessful or malformed gate evidence: ${existing.url}; inspect the complete matrix before manually requesting ci:full`,
      );
    }
    return retryFailed(port, repo, pr, existing, options.wait);
  }
  await requireUser(port);
  const reservation = await reserve(port, repo, pr);
  if (!reservation.owned) {
    return observeRequest(port, repo, pr, options.wait);
  }
  // Another explicit request may have become visible while reserving. Reuse its
  // exact bound run before emitting any labeled event.
  const appeared = await latestRun(port, repo, pr);
  if (appeared) {
    return finish(port, repo, pr, appeared, options.wait);
  }
  await unchanged(port, repo, pr);
  try {
    await port.gh(
      [
        "api",
        "--method",
        "POST",
        `repos/${repo.name}/issues/${pr.number}/labels`,
        "-f",
        `labels[]=${reservation.name}`,
      ],
      readTimeout,
    );
  } catch {
    /* Never retry an uncertain POST; discover its bound run. */
  }
  return observeRequest(port, repo, pr, options.wait);
}

export function createFullCiPort(
  gh: FullCiPort["gh"] = (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        "gh",
        [...args],
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(new Error("GitHub CLI failed or timed out; effect may be uncertain"));
          } else {
            resolve(stdout);
          }
        },
      );
    }),
): FullCiPort {
  return {
    gh,
    nonce: randomUUID,
    delay: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
  };
}

const invoked =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolvePath(process.argv[1])).href;
if (invoked === import.meta.url) {
  try {
    const result = await requestFullPrCi(process.argv.slice(2), createFullCiPort());
    process.stdout.write(
      `Full CI ${result.outcome}: ${result.url}\nHead ${result.head}; base ${result.base} (${result.baseRef})\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Full CI request failed"}\n`);
    process.exitCode = 1;
  }
}

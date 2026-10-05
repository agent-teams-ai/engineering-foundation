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
interface Options { readonly pr: number; readonly wait: boolean }
interface Repository { readonly name: string; readonly id: number; readonly workflowId: number }
interface Snapshot {
  readonly number: number; readonly head: string; readonly base: string; readonly baseRef: string;
  readonly headRepo: number; readonly headRepoName: string; readonly headRef: string; readonly baseRepo: number;
  readonly labels: readonly string[];
}
interface BoundRun { readonly id: number; readonly attempt: number; readonly status: string; readonly conclusion: unknown; readonly url: string }
export interface FullCiResult {
  readonly outcome: "ready" | "requested"; readonly url: string; readonly head: string; readonly base: string; readonly baseRef: string;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { throw new Error("Malformed GitHub metadata"); }
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) { throw new Error("Malformed GitHub identifier"); }
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) { throw new Error("Malformed GitHub revision"); }
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) { throw new Error("Malformed GitHub collection"); }
  return value;
}

export function parseFullCiArguments(input: readonly string[]): Options {
  const args = input[0] === "--" ? input.slice(1) : input;
  if (args.length < 2 || args.length > 3 || args[0] !== "--pr" ||
      !/^[1-9][0-9]*$/u.test(args[1] ?? "") || (args.length === 3 && args[2] !== "--wait")) {
    throw new Error("Usage: pnpm ci:full -- --pr N [--wait]");
  }
  return { pr: positive(Number(args[1])), wait: args[2] === "--wait" };
}

async function json(port: FullCiPort, args: readonly string[]): Promise<unknown> {
  // Retry transport reads only. Parsing failures and uncertain writes are final.
  let failures = 0;
  while (true) {
    let output: string;
    try { output = await port.gh(args, readTimeout); }
    catch (error) {
      failures += 1;
      if (failures === 3) { throw error; }
      await port.delay(failures * 250);
      continue;
    }
    return JSON.parse(output) as unknown;
  }
}
async function snapshot(port: FullCiPort, repo: Repository, pr: number): Promise<Snapshot> {
  const data = object(await json(port, ["api", `repos/${repo.name}/pulls/${pr}`]));
  const head = object(data.head); const base = object(data.base);
  const headRepo = object(head.repo); const baseRepo = object(base.repo);
  if (data.number !== pr || data.state !== "open" || baseRepo.id !== repo.id || baseRepo.full_name !== repo.name) {
    throw new Error("PR is not open in the canonical repository");
  }
  const headRepoName = headRepo.full_name;
  if (typeof headRepoName !== "string" || !repositoryName.test(headRepoName)) { throw new Error("Malformed PR source repository"); }
  const headRef = head.ref;
  if (typeof headRef !== "string" || headRef.length === 0) { throw new Error("Malformed PR source branch"); }
  const baseRef = base.ref;
  if (typeof baseRef !== "string" || baseRef.length === 0) { throw new Error("Malformed PR base branch"); }
  return { number: pr, head: sha(head.sha), base: sha(base.sha), headRepo: positive(headRepo.id),
    headRepoName, headRef, baseRef, baseRepo: repo.id, labels: array(data.labels).map(entry => {
      const name = object(entry).name;
      if (typeof name !== "string") { throw new Error("Malformed PR label"); }
      return name;
    }) };
}
async function unchanged(port: FullCiPort, repo: Repository, expected: Snapshot): Promise<Snapshot> {
  const current = await snapshot(port, repo, expected.number);
  if (current.head !== expected.head || current.base !== expected.base || current.headRepo !== expected.headRepo ||
      current.headRepoName !== expected.headRepoName || current.headRef !== expected.headRef || current.baseRef !== expected.baseRef) {
    throw new Error("PR head/base changed; request full CI for the new snapshot");
  }
  return current;
}

function associatedWithSnapshot(associations: unknown[], pr: Snapshot): boolean {
  // GitHub omits this array for forks. The frozen PR/head/base title, canonical
  // workflow and exact source repository/ref still bind those runs uniquely.
  if (associations.length === 0) { return pr.headRepo !== pr.baseRepo; }
  const requested = associations.map(object).filter(association => association.number === pr.number);
  if (requested.length !== 1) { return false; }
  const association = requested[0]!;
  const head = object(association.head); const base = object(association.base);
  return association.number === pr.number && head.sha === pr.head && base.sha === pr.base && head.ref === pr.headRef &&
    object(head.repo).id === pr.headRepo && object(base.repo).id === pr.baseRepo &&
    (base.ref === undefined || base.ref === pr.baseRef);
}

function boundRun(value: unknown, repo: Repository, pr: Snapshot): BoundRun | undefined {
  const data = object(value);
  const title = `Full CI #${pr.number} @${pr.head} on ${pr.base}`;
  // GitHub's run.name is the custom run-name, not the canonical workflow name.
  if (data.workflow_id !== repo.workflowId || data.path !== workflowPath || data.event !== "pull_request" ||
      data.head_sha !== pr.head || data.name !== title || data.display_title !== title) { return undefined; }
  const repository = object(data.repository);
  const source = object(data.head_repository);
  const associations = array(data.pull_requests);
  if (repository.id !== repo.id || repository.full_name !== repo.name ||
      source.id !== pr.headRepo || source.full_name !== pr.headRepoName || data.head_branch !== pr.headRef) { return undefined; }
  if (!associatedWithSnapshot(associations, pr)) { return undefined; }
  const id = positive(data.id); const attempt = positive(data.run_attempt);
  const url = `https://github.com/${repo.name}/actions/runs/${id}`;
  if (data.html_url !== url || typeof data.status !== "string" ||
      !["queued", "requested", "waiting", "pending", "in_progress", "completed"].includes(data.status)) {
    throw new Error("Malformed bound CI run");
  }
  return { id, attempt, url, status: data.status, conclusion: data.conclusion };
}

async function collection(port: FullCiPort, endpoint: string, field?: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  // Fail closed on truncation; do not miss an active request and duplicate it.
  for (let page = 1; page <= 3; page += 1) {
    const data = await json(port, ["api", `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`]);
    const batch = array(field === undefined ? data : object(data)[field]);
    entries.push(...batch);
    if (batch.length < 100) { return entries; }
  }
  throw new Error("GitHub discovery exceeded the 300-entry bound");
}
async function latestRun(port: FullCiPort, repo: Repository, pr: Snapshot): Promise<BoundRun | undefined> {
  const entries = await collection(port,
    `repos/${repo.name}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head}`, "workflow_runs");
  return entries.map(entry => boundRun(entry, repo, pr)).filter((run): run is BoundRun => run !== undefined)
    .toSorted((a, b) => b.id - a.id)[0];
}
async function rereadRun(port: FullCiPort, repo: Repository, pr: Snapshot, expected: BoundRun): Promise<BoundRun> {
  const run = boundRun(await json(port, ["api", `repos/${repo.name}/actions/runs/${expected.id}`]), repo, pr);
  if (!run || run.id !== expected.id || run.attempt !== expected.attempt) { throw new Error("Bound CI run identity/attempt changed"); }
  return run;
}
async function successful(port: FullCiPort, repo: Repository, pr: Snapshot, run: BoundRun): Promise<boolean> {
  if (run.status !== "completed" || run.conclusion !== "success") { return false; }
  // Selective retries retain successful jobs from earlier attempts. The latest
  // filter supplies each effective job; the run detail bounds its attempt.
  const jobs = await collection(port, `repos/${repo.name}/actions/runs/${run.id}/jobs?filter=latest`, "jobs");
  const records = jobs.map(object);
  return ["full-ci", "check", "windows-check", "macos-qualification"].every(name => {
    const gates = records.filter(job => job.name === name);
    if (gates.length !== 1) { return false; }
    const gate = gates[0]!;
    return typeof gate.id === "number" && Number.isSafeInteger(gate.id) && gate.id > 0 &&
      records.filter(job => job.id === gate.id).length === 1 &&
      gate.run_id === run.id && gate.head_sha === pr.head &&
      typeof gate.run_attempt === "number" && Number.isSafeInteger(gate.run_attempt) &&
      gate.run_attempt > 0 && gate.run_attempt <= run.attempt &&
      gate.status === "completed" && gate.conclusion === "success";
  });
}
async function finish(port: FullCiPort, repo: Repository, pr: Snapshot, run: BoundRun, wait: boolean): Promise<FullCiResult> {
  let current = await rereadRun(port, repo, pr, run);
  if (wait && current.status !== "completed") {
    // A failed watch may have lost its final response. Only fresh API evidence decides.
    try { await port.gh(["run", "watch", String(current.id), "--repo", repo.name, "--exit-status", "--interval", "10"], watchTimeout); } catch { /* Reconcile below. */ }
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
  if (!ready && (wait || current.status === "completed")) { throw new Error(`Full CI is not successful: ${current.url}`); }
  return { outcome: ready ? "ready" : "requested", url: current.url, head: pr.head, base: pr.base, baseRef: pr.baseRef };
}

async function requireUser(port: FullCiPort): Promise<void> {
  try {
    const user = object(await json(port, ["api", "user"]));
    positive(user.id);
    if (user.type !== "User" || typeof user.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(user.login)) {
      throw new Error("Not a user credential");
    }
  } catch {
    throw new Error("Full CI writes require a user-authenticated gh credential (GET /user with a valid User identity); GITHUB_TOKEN labeled events are suppressed");
  }
}

function reservationName(repo: Repository, pr: Snapshot, retry?: BoundRun): string {
  // An ordered, versioned array avoids ambiguous concatenation. Labels and
  // lifecycle status are observations, not part of the frozen source binding.
  const binding = ["ci-full-v1", repo.id, repo.name, pr.number, pr.head, pr.base, pr.baseRef,
    pr.headRepo, pr.headRepoName, pr.headRef, pr.baseRepo,
    ...(retry ? ["rerun-failed", retry.id, retry.attempt] : ["request"])];
  return `ci:full:${createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 40)}`;
}

async function reserve(port: FullCiPort, repo: Repository, pr: Snapshot, retry?: BoundRun): Promise<{ name: string; owned: boolean }> {
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
    await port.gh(["api", "--method", "POST", `repos/${repo.name}/labels`, "-f", `name=${name}`,
      "-f", "color=0e8a16", "-f", `description=${description}`], readTimeout);
  } catch { /* Every outcome, including success, is reconciled by an exact read. */ }
  let observed: Record<string, unknown>;
  try { observed = object(await json(port, ["api", `repos/${repo.name}/labels/${encodeURIComponent(name)}`])); }
  catch {
    throw new Error("Reservation creation effect uncertain: exact label ownership unavailable; inspect Actions and labels, then manually request ci:full if needed");
  }
  if (observed.name !== name || typeof observed.description !== "string") {
    throw new Error("Reservation ownership malformed; inspect Actions and labels before a manual ci:full request");
  }
  return { name, owned: observed.description === description };
}

async function observeRequest(port: FullCiPort, repo: Repository, pr: Snapshot, wait: boolean): Promise<FullCiResult> {
  for (let observation = 0; observation < 12; observation += 1) {
    await unchanged(port, repo, pr);
    const run = await latestRun(port, repo, pr);
    if (run) { return finish(port, repo, pr, run, wait); }
    if (observation < 11) { await port.delay(5_000); }
  }
  throw new Error("Request effect uncertain: reserved snapshot has no bound CI run; inspect Actions and labels before manually requesting ci:full; no automatic takeover or resubmission");
}

async function retryDetail(port: FullCiPort, repo: Repository, pr: Snapshot, previous: BoundRun): Promise<BoundRun> {
  const current = boundRun(await json(port, ["api", `repos/${repo.name}/actions/runs/${previous.id}`]), repo, pr);
  if (!current || current.id !== previous.id || current.attempt < previous.attempt || current.attempt > previous.attempt + 1) {
    throw new Error("Bound CI retry identity/attempt changed beyond the expected next attempt; inspect Actions before retrying");
  }
  const latest = await latestRun(port, repo, pr);
  if (!latest || latest.id !== current.id || latest.attempt < previous.attempt || latest.attempt > previous.attempt + 1) {
    throw new Error("Latest bound CI request changed during retry; inspect Actions before retrying");
  }
  return current;
}

async function observeRetry(port: FullCiPort, repo: Repository, pr: Snapshot, previous: BoundRun, wait: boolean): Promise<FullCiResult> {
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
    if (observation < 11) { await port.delay(5_000); }
  }
  throw new Error("Retry effect uncertain: no bound next attempt observed; inspect Actions and retry reservation before manual recovery; no rerun resubmitted");
}

async function retryFailed(port: FullCiPort, repo: Repository, pr: Snapshot, run: BoundRun, wait: boolean): Promise<FullCiResult> {
  await requireUser(port);
  const reservation = await reserve(port, repo, pr, run);
  if (reservation.owned) {
    const current = await retryDetail(port, repo, pr, run);
    await unchanged(port, repo, pr);
    if (current.attempt === run.attempt) {
      if (current.status !== run.status || current.conclusion !== run.conclusion) {
        throw new Error("Bound CI run status/conclusion changed before retry; inspect Actions before retrying");
      }
      try { await port.gh(["run", "rerun", String(run.id), "--repo", repo.name, "--failed"], readTimeout); }
      catch { /* An uncertain rerun is reconciled only by reading its next attempt. */ }
    }
  }
  // Retry reservations are repository labels only: attaching one to the PR
  // would emit a second full-matrix request.
  return observeRetry(port, repo, pr, run, wait);
}

async function requestContext(args: readonly string[], port: FullCiPort): Promise<{ options: Options; repo: Repository; pr: Snapshot }> {
  const options = parseFullCiArguments(args); // Validate before any IO or mutation.
  const name = object(await json(port, ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  if (typeof name !== "string" || !repositoryName.test(name)) { throw new Error("Malformed repository name"); }
  const metadata = object(await json(port, ["api", `repos/${name}`]));
  if (metadata.full_name !== name) { throw new Error("Repository identity changed"); }
  const workflow = object(await json(port, ["api", `repos/${name}/actions/workflows/ci.yml`]));
  if (workflow.name !== "CI" || workflow.path !== workflowPath) { throw new Error("Canonical CI workflow identity changed"); }
  const repo: Repository = { name, id: positive(metadata.id), workflowId: positive(workflow.id) };
  const pr = await snapshot(port, repo, options.pr);
  return { options, repo, pr };
}

// Gate consumers can inspect the same evidence without any request/retry
// admission, credential requirement, or label/rerun effect.
export async function readFullPrCi(args: readonly string[], port: FullCiPort): Promise<FullCiResult> {
  const { options, repo, pr } = await requestContext(args, port);
  const run = await latestRun(port, repo, pr);
  if (!run) { throw new Error("No exact bound full CI run; request qualification separately"); }
  return finish(port, repo, pr, run, options.wait);
}

export async function requestFullPrCi(args: readonly string[], port: FullCiPort): Promise<FullCiResult> {
  const { options, repo, pr } = await requestContext(args, port);
  const discovered = await latestRun(port, repo, pr);
  const existing = discovered === undefined ? undefined : await rereadRun(port, repo, pr, discovered);
  if (existing) {
    if (existing.status !== "completed" || await successful(port, repo, pr, existing)) {
      return finish(port, repo, pr, existing, options.wait);
    }
    if (!["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(String(existing.conclusion))) {
      throw new Error(`Full CI has unsuccessful or malformed gate evidence: ${existing.url}; inspect the complete matrix before manually requesting ci:full`);
    }
    return retryFailed(port, repo, pr, existing, options.wait);
  }
  await requireUser(port);
  const reservation = await reserve(port, repo, pr);
  if (!reservation.owned) { return observeRequest(port, repo, pr, options.wait); }
  // Another explicit request may have become visible while reserving. Reuse its
  // exact bound run before emitting any labeled event.
  const appeared = await latestRun(port, repo, pr);
  if (appeared) { return finish(port, repo, pr, appeared, options.wait); }
  await unchanged(port, repo, pr);
  try { await port.gh(["api", "--method", "POST", `repos/${repo.name}/issues/${pr.number}/labels`, "-f", `labels[]=${reservation.name}`], readTimeout); }
  catch { /* Never retry an uncertain POST; discover its bound run. */ }
  return observeRequest(port, repo, pr, options.wait);
}

export function createFullCiPort(gh: FullCiPort["gh"] = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("gh", [...args], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) { reject(new Error("GitHub CLI failed or timed out; effect may be uncertain")); }
    else { resolve(stdout); }
  });
})): FullCiPort {
  return {
    gh,
    nonce: randomUUID,
    delay: milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); }),
  };
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolvePath(process.argv[1])).href;
if (invoked === import.meta.url) {
  try {
    const result = await requestFullPrCi(process.argv.slice(2), createFullCiPort());
    process.stdout.write(`Full CI ${result.outcome}: ${result.url}\nHead ${result.head}; base ${result.base} (${result.baseRef})\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Full CI request failed"}\n`);
    process.exitCode = 1;
  }
}

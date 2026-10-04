import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const label = "ci:full";
const workflowPath = ".github/workflows/ci.yml";
const readTimeout = 20_000;
const watchTimeout = 90 * 60_000;

// Private host IO boundary: tests supply metadata and record actual effect intent.
export interface FullCiPort {
  gh(args: readonly string[], timeoutMs: number): Promise<string>;
  delay(milliseconds: number): Promise<void>;
}
interface Options { readonly pr: number; readonly wait: boolean }
interface Repository { readonly name: string; readonly id: number }
interface Snapshot {
  readonly number: number; readonly head: string; readonly base: string;
  readonly headRepo: number; readonly baseRepo: number; readonly labels: readonly string[];
}
interface BoundRun { readonly id: number; readonly attempt: number; readonly status: string; readonly conclusion: unknown; readonly url: string }
export interface FullCiResult { readonly outcome: "ready" | "requested"; readonly url: string; readonly head: string; readonly base: string }

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
  return JSON.parse(await port.gh(args, readTimeout)) as unknown;
}
async function snapshot(port: FullCiPort, repo: Repository, pr: number): Promise<Snapshot> {
  const data = object(await json(port, ["api", `repos/${repo.name}/pulls/${pr}`]));
  const head = object(data.head); const base = object(data.base);
  const headRepo = object(head.repo); const baseRepo = object(base.repo);
  if (data.number !== pr || data.state !== "open" || baseRepo.id !== repo.id || baseRepo.full_name !== repo.name) {
    throw new Error("PR is not open in the canonical repository");
  }
  return { number: pr, head: sha(head.sha), base: sha(base.sha), headRepo: positive(headRepo.id),
    baseRepo: repo.id, labels: array(data.labels).map(entry => {
      const name = object(entry).name;
      if (typeof name !== "string") { throw new Error("Malformed PR label"); }
      return name;
    }) };
}
async function unchanged(port: FullCiPort, repo: Repository, expected: Snapshot): Promise<Snapshot> {
  const current = await snapshot(port, repo, expected.number);
  if (current.head !== expected.head || current.base !== expected.base || current.headRepo !== expected.headRepo) {
    throw new Error("PR head/base changed; request full CI for the new snapshot");
  }
  return current;
}

function boundRun(value: unknown, repo: Repository, pr: Snapshot): BoundRun | undefined {
  const data = object(value);
  if (data.name !== "CI" || data.path !== workflowPath || data.event !== "pull_request" ||
      data.head_sha !== pr.head || data.display_title !== `Full CI #${pr.number} @${pr.head} on ${pr.base}`) { return undefined; }
  const repository = object(data.repository);
  const associations = array(data.pull_requests);
  if (repository.id !== repo.id || repository.full_name !== repo.name || associations.length !== 1) { return undefined; }
  const association = object(associations[0]);
  const head = object(association.head); const base = object(association.base);
  if (association.number !== pr.number || head.sha !== pr.head || base.sha !== pr.base ||
      object(head.repo).id !== pr.headRepo || object(base.repo).id !== pr.baseRepo) { return undefined; }
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
async function successful(port: FullCiPort, repo: Repository, run: BoundRun): Promise<boolean> {
  if (run.status !== "completed" || run.conclusion !== "success") { return false; }
  const jobs = await collection(port, `repos/${repo.name}/actions/runs/${run.id}/attempts/${run.attempt}/jobs`, "jobs");
  const gates = jobs.map(object).filter(job => job.name === "full-ci");
  return gates.length === 1 && gates[0]!.run_id === run.id && gates[0]!.status === "completed" && gates[0]!.conclusion === "success";
}
async function finish(port: FullCiPort, repo: Repository, pr: Snapshot, run: BoundRun, wait: boolean): Promise<FullCiResult> {
  if (wait && run.status !== "completed") {
    // A failed watch may have lost its final response. Only fresh API evidence decides.
    try { await port.gh(["run", "watch", String(run.id), "--repo", repo.name, "--exit-status", "--interval", "10"], watchTimeout); } catch { /* Reconcile below. */ }
  }
  const current = await rereadRun(port, repo, pr, run);
  const ready = await successful(port, repo, current);
  const newest = await latestRun(port, repo, pr);
  if (!newest || newest.id !== current.id || newest.attempt !== current.attempt ||
      newest.status !== current.status || newest.conclusion !== current.conclusion) {
    throw new Error("Latest bound CI request changed; inspect Actions before retrying");
  }
  await unchanged(port, repo, pr);
  if (!ready && (wait || current.status === "completed")) { throw new Error(`Full CI is not successful: ${current.url}`); }
  return { outcome: ready ? "ready" : "requested", url: current.url, head: pr.head, base: pr.base };
}

async function ensureLabel(port: FullCiPort, repo: Repository): Promise<void> {
  const labels = await collection(port, `repos/${repo.name}/labels`);
  if (labels.some(entry => object(entry).name === label)) { return; }
  try {
    await port.gh(["api", "--method", "POST", `repos/${repo.name}/labels`, "-f", `name=${label}`,
      "-f", "color=0e8a16", "-f", "description=Request complete native PR qualification"], readTimeout);
  } catch {
    const observed = object(await json(port, ["api", `repos/${repo.name}/labels/${encodeURIComponent(label)}`]));
    if (observed.name !== label) { throw new Error("Repository label creation was not reconciled"); }
  }
}

export async function requestFullPrCi(args: readonly string[], port: FullCiPort): Promise<FullCiResult> {
  const options = parseFullCiArguments(args); // Validate before any IO or mutation.
  const name = object(await json(port, ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name)) { throw new Error("Malformed repository name"); }
  const metadata = object(await json(port, ["api", `repos/${name}`]));
  if (metadata.full_name !== name) { throw new Error("Repository identity changed"); }
  const repo: Repository = { name, id: positive(metadata.id) };
  const pr = await snapshot(port, repo, options.pr);
  const existing = await latestRun(port, repo, pr);
  if (existing && (existing.status !== "completed" || await successful(port, repo, existing))) {
    return finish(port, repo, pr, existing, options.wait);
  }
  await ensureLabel(port, repo);
  const current = await unchanged(port, repo, pr);
  if (current.labels.includes(label)) {
    // An existing label does not emit another labeled event. Re-request once.
    try { await port.gh(["api", "--method", "DELETE", `repos/${repo.name}/issues/${pr.number}/labels/${encodeURIComponent(label)}`], readTimeout); }
    catch { /* Verify the effect rather than repeat an uncertain DELETE. */ }
    if ((await unchanged(port, repo, pr)).labels.includes(label)) { throw new Error("Label removal was not reconciled; no request posted"); }
  }
  await unchanged(port, repo, pr);
  try { await port.gh(["api", "--method", "POST", `repos/${repo.name}/issues/${pr.number}/labels`, "-f", `labels[]=${label}`], readTimeout); }
  catch { /* Never retry an uncertain POST; discover its bound run. */ }
  for (let observation = 0; observation < 12; observation += 1) {
    await unchanged(port, repo, pr);
    const run = await latestRun(port, repo, pr);
    if (run && (!existing || run.id > existing.id)) { return finish(port, repo, pr, run, options.wait); }
    if (observation < 11) { await port.delay(5_000); }
  }
  throw new Error("Request effect uncertain: no new exact-head/base full CI run found; inspect Actions before retrying");
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolvePath(process.argv[1])).href;
if (invoked === import.meta.url) {
  const port: FullCiPort = {
    gh: (args, timeoutMs) => new Promise((resolve, reject) => {
      execFile("gh", [...args], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(new Error("GitHub CLI failed or timed out; effect may be uncertain")); }
        else { resolve(stdout); }
      });
    }),
    delay: milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); }),
  };
  try {
    const result = await requestFullPrCi(process.argv.slice(2), port);
    process.stdout.write(`Full CI ${result.outcome}: ${result.url}\nHead ${result.head}; base ${result.base}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Full CI request failed"}\n`);
    process.exitCode = 1;
  }
}

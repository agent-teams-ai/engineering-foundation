import type { FullCiPort } from "./request-full-pr-ci.mts";
const workflowPath = ".github/workflows/ci.yml";
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const readTimeout = 20_000;
export interface Repository {
  readonly name: string;
  readonly id: number;
  readonly workflowId: number;
}
export interface Snapshot {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly baseRef: string;
  readonly headRepo: number;
  readonly headRepoName: string;
  readonly headRef: string;
  readonly baseRepo: number;
  readonly labels: readonly string[];
}
export interface BoundRun {
  readonly id: number;
  readonly attempt: number;
  readonly status: string;
  readonly conclusion: unknown;
  readonly url: string;
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed GitHub metadata");
  }
  return value as Record<string, unknown>;
}
export function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Malformed GitHub identifier");
  }
  return value;
}
export function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("Malformed GitHub revision");
  }
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Malformed GitHub collection");
  }
  return value;
}

export async function json(port: FullCiPort, args: readonly string[]): Promise<unknown> {
  // Retry transport reads only. Parsing failures and uncertain writes are final.
  let failures = 0;
  for (;;) {
    let output: string;
    try {
      output = await port.gh(args, readTimeout);
    } catch (error) {
      failures += 1;
      if (failures === 3) {
        throw error;
      }
      await port.delay(failures * 250);
      continue;
    }
    return JSON.parse(output) as unknown;
  }
}
export async function snapshot(port: FullCiPort, repo: Repository, pr: number): Promise<Snapshot> {
  const data = object(await json(port, ["api", `repos/${repo.name}/pulls/${pr}`]));
  const head = object(data.head);
  const base = object(data.base);
  const headRepo = object(head.repo);
  const baseRepo = object(base.repo);
  if (
    data.number !== pr ||
    data.state !== "open" ||
    baseRepo.id !== repo.id ||
    baseRepo.full_name !== repo.name
  ) {
    throw new Error("PR is not open in the canonical repository");
  }
  const headRepoName = headRepo.full_name;
  if (typeof headRepoName !== "string" || !repositoryName.test(headRepoName)) {
    throw new Error("Malformed PR source repository");
  }
  const headRef = head.ref;
  if (typeof headRef !== "string" || headRef.length === 0) {
    throw new Error("Malformed PR source branch");
  }
  const baseRef = base.ref;
  if (typeof baseRef !== "string" || baseRef.length === 0) {
    throw new Error("Malformed PR base branch");
  }
  return {
    number: pr,
    head: sha(head.sha),
    base: sha(base.sha),
    headRepo: positive(headRepo.id),
    headRepoName,
    headRef,
    baseRef,
    baseRepo: repo.id,
    labels: array(data.labels).map((entry) => {
      const name = object(entry).name;
      if (typeof name !== "string") {
        throw new Error("Malformed PR label");
      }
      return name;
    }),
  };
}
export async function unchanged(
  port: FullCiPort,
  repo: Repository,
  expected: Snapshot,
): Promise<Snapshot> {
  const current = await snapshot(port, repo, expected.number);
  if (
    current.head !== expected.head ||
    current.base !== expected.base ||
    current.headRepo !== expected.headRepo ||
    current.headRepoName !== expected.headRepoName ||
    current.headRef !== expected.headRef ||
    current.baseRef !== expected.baseRef
  ) {
    throw new Error("PR head/base changed; request full CI for the new snapshot");
  }
  return current;
}

function associatedWithSnapshot(associations: unknown[], pr: Snapshot): boolean {
  // GitHub omits this array for forks. The frozen PR/head/base title, canonical
  // workflow and exact source repository/ref still bind those runs uniquely.
  if (associations.length === 0) {
    return pr.headRepo !== pr.baseRepo;
  }
  const requested = associations
    .map(object)
    .filter((association) => association.number === pr.number);
  if (requested.length !== 1) {
    return false;
  }
  const association = requested.at(0)!;
  const head = object(association.head);
  const base = object(association.base);
  return (
    association.number === pr.number &&
    head.sha === pr.head &&
    base.sha === pr.base &&
    head.ref === pr.headRef &&
    object(head.repo).id === pr.headRepo &&
    object(base.repo).id === pr.baseRepo &&
    (base.ref === undefined || base.ref === pr.baseRef)
  );
}

export function boundRun(value: unknown, repo: Repository, pr: Snapshot): BoundRun | undefined {
  const data = object(value);
  const title = `Full CI #${pr.number} @${pr.head} on ${pr.base}`;
  // GitHub's run.name is the custom run-name, not the canonical workflow name.
  if (
    data.workflow_id !== repo.workflowId ||
    data.path !== workflowPath ||
    data.event !== "pull_request" ||
    data.head_sha !== pr.head ||
    data.name !== title ||
    data.display_title !== title
  ) {
    return undefined;
  }
  const repository = object(data.repository);
  const source = object(data.head_repository);
  const associations = array(data.pull_requests);
  if (
    repository.id !== repo.id ||
    repository.full_name !== repo.name ||
    source.id !== pr.headRepo ||
    source.full_name !== pr.headRepoName ||
    data.head_branch !== pr.headRef
  ) {
    return undefined;
  }
  if (!associatedWithSnapshot(associations, pr)) {
    return undefined;
  }
  const id = positive(data.id);
  const attempt = positive(data.run_attempt);
  const url = `https://github.com/${repo.name}/actions/runs/${id}`;
  if (
    data.html_url !== url ||
    typeof data.status !== "string" ||
    !["queued", "requested", "waiting", "pending", "in_progress", "completed"].includes(data.status)
  ) {
    throw new Error("Malformed bound CI run");
  }
  return { id, attempt, url, status: data.status, conclusion: data.conclusion };
}

export async function collection(
  port: FullCiPort,
  endpoint: string,
  field?: string,
): Promise<unknown[]> {
  const entries: unknown[] = [];
  // Fail closed on truncation; do not miss an active request and duplicate it.
  for (let page = 1; page <= 3; page += 1) {
    const data = await json(port, [
      "api",
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    ]);
    const batch = array(field === undefined ? data : object(data)[field]);
    entries.push(...batch);
    if (batch.length < 100) {
      return entries;
    }
  }
  throw new Error("GitHub discovery exceeded the 300-entry bound");
}

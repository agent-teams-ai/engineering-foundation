import { isAbsolute, posix, resolve as resolvePath } from "node:path";
const workflowPath = ".github/workflows/ci.yml";
export interface MergeProfile {
  readonly repository: string;
  readonly repositoryId: number;
  readonly registry: string;
  readonly workspaces: string;
  readonly jobs: readonly string[];
}
export interface MergeOptions {
  readonly pr: number;
  readonly reviewJob: string;
  readonly reviewHost: string;
  readonly reviewRegistry: string;
  readonly expectedHead: string;
  readonly expectedBaseRef: string;
  readonly expectedBase: string;
  readonly subject: string;
  readonly bodyFile: string;
}
export interface MergeBinding {
  readonly repository: string;
  readonly repositoryId: number;
  readonly pr: number;
  readonly head: string;
  readonly baseRef: string;
  readonly base: string;
  readonly sourceRepositoryId: number;
  readonly sourceRepository: string;
  readonly sourceRef: string;
  readonly workflowId: number;
  readonly workflowBlobSha: string;
}
// Private IO boundary. The verifier has no mutation capability, nor receipt-file input.
export interface MergeGithubPort {
  gh(args: readonly string[]): Promise<string>;
}
export interface MergeReadPort extends MergeGithubPort {
  review(options: MergeOptions, binding: MergeBinding): Promise<unknown>;
}
export interface MergePort extends MergeReadPort {
  canonicalOwnerMerge(binding: MergeBinding, options: MergeOptions): Promise<void>;
}
export function demand(condition: unknown, message: string): asserts condition {
  const accepted = Boolean(condition);
  if (!accepted) {
    throw new Error(message);
  }
}
export function object(value: unknown): Record<string, unknown> {
  demand(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Malformed metadata object",
  );
  return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] {
  demand(Array.isArray(value), "Malformed metadata array");
  return value;
}
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Malformed JSON metadata");
  }
}
export function sha(value: unknown): string {
  demand(
    typeof value === "string" && /^(?!0{40}$)[a-f0-9]{40}$/u.test(value),
    "Invalid exact revision",
  );
  return value;
}
export function positive(value: unknown): number {
  demand(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "Invalid identifier",
  );
  return value;
}
export function safeBodyPath(value: string): boolean {
  return (
    isAbsolute(value) && resolvePath(value) === value && !/[\p{Cc}]/u.test(value) && value !== "/"
  );
}
export function safeRemotePath(value: string): boolean {
  return (
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    !/[\p{Cc}\\]/u.test(value) &&
    value !== "/"
  );
}
export function safeRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
export function parseMergeArguments(input: readonly string[]): MergeOptions {
  const args = input[0] === "--" ? input.slice(1) : input;
  const names = [
    "pr",
    "review-job",
    "review-host",
    "review-registry",
    "expected-head",
    "expected-base-ref",
    "expected-base",
    "subject",
    "body-file",
  ];
  const values: Record<string, string | undefined> = {};
  demand(args.length === names.length * 2, "Expected all nine ci:merge options exactly once");
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    const value = args[i + 1];
    demand(
      args[i]?.startsWith("--") &&
        key &&
        names.includes(key) &&
        !Object.hasOwn(values, key) &&
        typeof value === "string" &&
        value.length > 0 &&
        !/[\p{Cc}]/u.test(value),
      "Invalid ci:merge option",
    );
    values[key] = value;
  }
  demand(/^[1-9][0-9]*$/u.test(values.pr!), "Invalid PR number");
  demand(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(values["review-job"]!), "Invalid review job");
  demand(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(values["review-host"]!), "Invalid SSH alias");
  demand(
    safeRemotePath(values["review-registry"]!) && safeBodyPath(values["body-file"]!),
    "Paths must be absolute and normalized",
  );
  demand(safeRef(values["expected-base-ref"]), "Invalid base ref");
  demand(
    values.subject === values.subject!.trim() &&
      !/[\p{Zl}\p{Zp}]/u.test(values.subject) &&
      /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()]+\))?!?: \S.*$/u.test(
        values.subject,
      ),
    "Invalid Conventional Commit subject",
  );
  return {
    pr: positive(Number(values.pr)),
    reviewJob: values["review-job"]!,
    reviewHost: values["review-host"]!,
    reviewRegistry: values["review-registry"]!,
    expectedHead: sha(values["expected-head"]),
    expectedBaseRef: values["expected-base-ref"],
    expectedBase: sha(values["expected-base"]),
    subject: values.subject,
    bodyFile: values["body-file"]!,
  };
}
export async function api(port: MergeGithubPort, endpoint: string): Promise<unknown> {
  return parseJson(await port.gh(["api", "--hostname", "github.com", "--method", "GET", endpoint]));
}
export async function collection(
  port: MergeGithubPort,
  endpoint: string,
  field: string,
): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const data = object(
      await api(port, `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`),
    );
    const batch = array(data[field]);
    entries.push(...batch);
    if (batch.length < 100) {
      return entries;
    }
  }
  throw new Error("Discovery exceeds 300 records; no merge admitted");
}
export async function pull(
  port: MergeGithubPort,
  profile: MergeProfile,
  options: MergeOptions,
): Promise<Omit<MergeBinding, "workflowId" | "workflowBlobSha">> {
  const data = object(await api(port, `repos/${profile.repository}/pulls/${options.pr}`));
  const head = object(data.head);
  const base = object(data.base);
  const source = object(head.repo);
  const target = object(base.repo);
  demand(
    data.number === options.pr &&
      data.state === "open" &&
      data.merged === false &&
      target.id === profile.repositoryId &&
      target.full_name === profile.repository,
    "PR is not open in the fixed repository",
  );
  demand(
    head.sha === options.expectedHead &&
      base.sha === options.expectedBase &&
      base.ref === options.expectedBaseRef,
    "PR head/base/ref changed; obtain fresh review and CI",
  );
  demand(
    typeof source.full_name === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.full_name) &&
      safeRef(head.ref),
    "Invalid source identity",
  );
  return {
    repository: profile.repository,
    repositoryId: profile.repositoryId,
    pr: options.pr,
    head: sha(head.sha),
    base: sha(base.sha),
    baseRef: base.ref,
    sourceRepositoryId: positive(source.id),
    sourceRepository: source.full_name,
    sourceRef: head.ref,
  };
}
export async function unchanged(
  port: MergeGithubPort,
  profile: MergeProfile,
  options: MergeOptions,
  binding: MergeBinding,
): Promise<void> {
  const current = await pull(port, profile, options);
  demand(
    Object.entries(current).every(([key, value]) => binding[key as keyof MergeBinding] === value),
    "PR source identity changed",
  );
}
export function boundRun(
  value: unknown,
  binding: MergeBinding,
): Record<string, unknown> | undefined {
  const run = object(value);
  const title = `Full CI #${binding.pr} @${binding.head} on ${binding.base}`;
  if (
    run.workflow_id !== binding.workflowId ||
    run.path !== workflowPath ||
    run.name !== title ||
    run.display_title !== title ||
    run.event !== "pull_request" ||
    run.head_sha !== binding.head ||
    run.head_branch !== binding.sourceRef
  ) {
    return undefined;
  }
  const repo = object(run.repository);
  const source = object(run.head_repository);
  const associations = array(run.pull_requests);
  if (
    repo.id !== binding.repositoryId ||
    repo.full_name !== binding.repository ||
    source.id !== binding.sourceRepositoryId ||
    source.full_name !== binding.sourceRepository
  ) {
    return undefined;
  }
  // GitHub's fork runs omit associations; exact title and source/ref still bind the run.
  if (!associated(associations, binding)) {
    return undefined;
  }
  positive(run.id);
  positive(run.run_attempt);
  return run;
}
function associated(associations: unknown[], binding: MergeBinding): boolean {
  if (associations.length === 0) {
    return binding.sourceRepositoryId !== binding.repositoryId;
  }
  const matches = associations.map(object).filter((pr) => pr.number === binding.pr);
  if (matches.length !== 1) {
    return false;
  }
  const pr = matches.at(0)!;
  const head = object(pr.head);
  const base = object(pr.base);
  return (
    head.sha === binding.head &&
    base.sha === binding.base &&
    head.ref === binding.sourceRef &&
    (!Object.hasOwn(base, "ref") || base.ref === binding.baseRef) &&
    object(head.repo).id === binding.sourceRepositoryId &&
    object(base.repo).id === binding.repositoryId
  );
}
async function latest(
  port: MergeGithubPort,
  binding: MergeBinding,
): Promise<Record<string, unknown>> {
  const runs = (
    await collection(
      port,
      `repos/${binding.repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${binding.head}`,
      "workflow_runs",
    )
  )
    .map((entry) => boundRun(entry, binding))
    .filter((run): run is Record<string, unknown> => run !== undefined);
  const run = runs.toSorted((a, b) => positive(b.id) - positive(a.id)).at(0);
  demand(run, "No exact-head/base full CI; request ci:full separately");
  return run;
}
function successfulRun(
  value: unknown,
  binding: MergeBinding,
  selected: Record<string, unknown>,
): void {
  const run = boundRun(value, binding);
  demand(
    run &&
      run.id === selected.id &&
      run.run_attempt === selected.run_attempt &&
      run.status === "completed" &&
      run.conclusion === "success",
    "CI detail identity/attempt/status changed or failed",
  );
}
export async function verifyNativeCi(
  port: MergeGithubPort,
  binding: MergeBinding,
  profile: MergeProfile,
): Promise<void> {
  const run = await latest(port, binding);
  const endpoint = `repos/${binding.repository}/actions/runs/${positive(run.id)}`;
  successfulRun(await api(port, endpoint), binding, run);
  const jobs = (
    await collection(port, `${endpoint}/attempts/${positive(run.run_attempt)}/jobs`, "jobs")
  ).map(object);
  demand(
    new Set(jobs.map((job) => positive(job.id))).size === jobs.length,
    "Duplicate CI job identifiers",
  );
  demand(new Set(jobs.map((job) => job.name)).size === jobs.length, "Duplicate CI job names");
  demand(
    jobs.every(
      (job) =>
        typeof job.name === "string" &&
        job.run_id === run.id &&
        job.head_sha === binding.head &&
        (!Object.hasOwn(job, "run_attempt") || job.run_attempt === run.run_attempt) &&
        job.status === "completed" &&
        (profile.jobs.includes(job.name)
          ? job.conclusion === "success"
          : job.name === "advisory-shadow-classifier"),
    ),
    "Native CI job metadata is stale or unsuccessful",
  );
  for (const name of profile.jobs) {
    // GitHub binds jobs through the attempt-specific endpoint.
    // Refuse a conflicting explicit attempt when a provider returns one, and never union historical endpoints.
    demand(jobs.filter((job) => job.name === name).length === 1, `Native CI lane missing: ${name}`);
  }
  successfulRun(await api(port, endpoint), binding, run);
  const newest = await latest(port, binding);
  demand(
    newest.id === run.id && newest.run_attempt === run.run_attempt,
    "Latest full CI run changed",
  );
}

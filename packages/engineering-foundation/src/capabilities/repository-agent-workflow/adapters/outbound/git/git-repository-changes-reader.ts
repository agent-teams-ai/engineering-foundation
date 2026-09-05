import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { FoundationError } from "../../../../../errors.js";
import type { RepositoryChangesReader } from "../../../application/ports/changed-workflow.js";
import type {
  RepositoryChangeGroup,
  RepositoryChangeGroups
} from "../../../application/model/changed-workflow.js";
import type { ExecuteWorkflowProcess } from "../../../application/ports/process-execution.js";

const AUTO_BASE_REFS = [
  { display: "origin/main", ref: "refs/remotes/origin/main" },
  { display: "origin/master", ref: "refs/remotes/origin/master" },
  { display: "main", ref: "refs/heads/main" },
  { display: "master", ref: "refs/heads/master" }
] as const;
const FULL_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;
const GIT_HARDENING = [
  "--no-pager",
  "--no-optional-locks",
  "--no-replace-objects",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.renames=false"
] as const;

function invalid(message: string): never {
  throw new FoundationError("CONSUMER_INVALID", message);
}

function parseNullDelimited(value: string, context: string): readonly string[] {
  if (value.length === 0) {
    return [];
  }
  if (!value.endsWith("\0")) {
    invalid(`Git returned malformed NUL-delimited ${context} evidence.`);
  }
  const paths = value.slice(0, -1).split("\0");
  if (paths.some((path) => path.length === 0)) {
    invalid(`Git returned an empty path in ${context} evidence.`);
  }
  return paths;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      return true;
    }
  }
  return false;
}

function assertSafeRepositoryPath(path: string): void {
  if (
    path.includes("\0") ||
    hasControlCharacter(path) ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../")
  ) {
    invalid(`Git reported an unsafe repository path: ${JSON.stringify(path)}.`);
  }
}

async function git(execute: ExecuteWorkflowProcess, root: string, args: readonly string[], signal?: AbortSignal) {
  try {
    return await execute("git", [...GIT_HARDENING, ...args], {
      cwd: root,
      strictUtf8: true,
      ...(signal === undefined ? {} : { signal })
    });
  } catch (error) {
    if (error instanceof Error && /not valid UTF-8/u.test(error.message)) {
      invalid("Git returned repository evidence that is not valid UTF-8.");
    }
    throw error;
  }
}

function exactCommit(value: string, context: string): string {
  const commit = value.replace(/\r?\n$/u, "");
  if (!FULL_COMMIT.test(commit)) {
    invalid(`Git did not return an immutable ${context} commit identifier.`);
  }
  return commit.toLowerCase();
}

async function resolveCommit(execute: ExecuteWorkflowProcess,
  root: string,
  ref: string,
  signal?: AbortSignal
): Promise<string | null> {
  const resolved = await git(execute,
    root,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    signal
  );
  if (resolved.exitCode === 0) {
    return exactCommit(resolved.stdout, "resolved");
  }
  if (resolved.exitCode === 1) {
    return null;
  }
  invalid(
    `Git could not resolve an immutable commit: ${resolved.stderr.trim() || "git rev-parse failed"}.`
  );
}

async function assertExactRef(execute: ExecuteWorkflowProcess,
  root: string,
  ref: string,
  signal?: AbortSignal
): Promise<void> {
  const result = await git(execute, root, ["check-ref-format", ref], signal);
  if (result.exitCode === 0) {
    return;
  }
  if (result.exitCode === 1) {
    invalid(
      `The explicit base ref ${JSON.stringify(ref)} is not an exact Git ref name.`
    );
  }
  invalid(
    `Git could not validate the explicit base ref: ${result.stderr.trim() || "git check-ref-format failed"}.`
  );
}

async function resolveRequestedRef(execute: ExecuteWorkflowProcess,
  root: string,
  requested: string,
  signal?: AbortSignal
): Promise<{ readonly ref: string; readonly commit: string } | null> {
  if (requested === "HEAD" || FULL_COMMIT.test(requested)) {
    const commit = await resolveCommit(execute, root, requested, signal);
    return commit === null ? null : { ref: requested, commit };
  }
  if (requested.startsWith("refs/")) {
    await assertExactRef(execute, root, requested, signal);
    const commit = await resolveCommit(execute, root, requested, signal);
    return commit === null ? null : { ref: requested, commit };
  }
  const candidates = [
    `refs/heads/${requested}`,
    `refs/remotes/${requested}`,
    `refs/tags/${requested}`
  ];
  await assertExactRef(execute, root, `refs/heads/${requested}`, signal);
  const matches = (
    await Promise.all(
      candidates.map(async (ref) => ({ ref, commit: await resolveCommit(execute, root, ref, signal) }))
    )
  ).filter((match): match is { readonly ref: string; readonly commit: string } =>
    match.commit !== null
  );
  if (matches.length > 1) {
    invalid(
      `The explicit base ref ${JSON.stringify(requested)} is ambiguous: ${matches.map(({ ref }) => ref).join(", ")}.`
    );
  }
  return matches[0] ?? null;
}

async function uniqueMergeBase(execute: ExecuteWorkflowProcess,
  root: string,
  headCommit: string,
  baseCommit: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await git(execute,
    root,
    ["merge-base", "--all", "--", headCommit, baseCommit],
    signal
  );
  if (result.exitCode === 1) {
    return null;
  }
  if (result.exitCode !== 0) {
    invalid(
      `Git could not inspect merge bases: ${result.stderr.trim() || "git merge-base failed"}.`
    );
  }
  const lines = result.stdout.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    invalid("Git did not return a merge-base commit identifier.");
  }
  const commits = lines.map((value) => exactCommit(value, "merge-base"));
  if (commits.length !== 1) {
    invalid(
      `Git reported ${String(commits.length)} merge bases; changed scope requires one unique merge base.`
    );
  }
  return commits[0] ?? null;
}

interface BaselineResolution {
  readonly requestedRef: string | null;
  readonly resolvedRef: string;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
  readonly mergeBaseCommit: string | null;
  readonly baselineRef: string;
  readonly baselineCommit: string | null;
}

async function resolveBaseline(execute: ExecuteWorkflowProcess,
  root: string,
  requested: string | undefined,
  signal?: AbortSignal
): Promise<BaselineResolution> {
  const headCommit = await resolveCommit(execute, root, "HEAD", signal);
  if (headCommit === null) {
    if (requested !== undefined) {
      invalid("An explicit base cannot be resolved before the repository has an initial commit.");
    }
    return {
      requestedRef: null,
      resolvedRef: "unborn-head",
      baseCommit: null,
      headCommit: null,
      mergeBaseCommit: null,
      baselineRef: "unborn-head",
      baselineCommit: null
    };
  }

  const candidates = requested === undefined
    ? AUTO_BASE_REFS
    : [{ display: requested, ref: requested }];
  let resolvedCandidateCount = 0;
  for (const candidate of candidates) {
    const resolved = requested === undefined
      ? await resolveCommit(execute, root, candidate.ref, signal).then((commit) =>
          commit === null ? null : { ref: candidate.ref, commit }
        )
      : await resolveRequestedRef(execute, root, candidate.ref, signal);
    if (resolved === null) {
      continue;
    }
    resolvedCandidateCount += 1;
    const mergeBaseCommit = await uniqueMergeBase(execute,
      root,
      headCommit,
      resolved.commit,
      signal
    );
    if (mergeBaseCommit !== null) {
      return {
        requestedRef: requested ?? null,
        resolvedRef: resolved.ref,
        baseCommit: resolved.commit,
        headCommit,
        mergeBaseCommit,
        baselineRef: candidate.display,
        baselineCommit: mergeBaseCommit
      };
    }
  }
  if (requested !== undefined) {
    invalid(`Unable to resolve one exact merge base for ${JSON.stringify(requested)}.`);
  }
  if (resolvedCandidateCount > 0) {
    invalid(
      "Unable to establish a merge base from the discovered refs; the history may be shallow or unrelated. Fetch the required history or pass an explicit base."
    );
  }
  return {
    requestedRef: null,
    resolvedRef: "HEAD",
    baseCommit: headCommit,
    headCommit,
    mergeBaseCommit: headCommit,
    baselineRef: "HEAD",
    baselineCommit: headCommit
  };
}

async function existingFiles(
  root: string,
  paths: readonly string[]
): Promise<readonly string[]> {
  const result: string[] = [];
  for (const path of paths) {
    const candidate = resolve(root, path);
    const relation = relative(root, candidate);
    if (relation.startsWith(`..${sep}`) || relation === "..") {
      invalid(`Changed path escapes the repository: ${path}.`);
    }
    const metadata = await lstat(candidate).catch(() => null);
    if (metadata === null) {
      continue;
    }
    if (!metadata.isFile()) {
      invalid(`Changed path is not a regular file: ${path}.`);
    }
    result.push(path);
  }
  return Object.freeze(result);
}

const DIFF_PATH_OPTIONS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--name-only",
  "-z"
] as const;

async function diffGroup(execute: ExecuteWorkflowProcess,
  root: string,
  prefix: readonly string[],
  signal?: AbortSignal
): Promise<RepositoryChangeGroup> {
  const [all, deleted] = await Promise.all([
    git(execute, root, ["diff", ...prefix, ...DIFF_PATH_OPTIONS, "--end-of-options", "--"], signal),
    git(execute,
      root,
      ["diff", ...prefix, "--diff-filter=D", ...DIFF_PATH_OPTIONS, "--end-of-options", "--"],
      signal
    )
  ]);
  for (const result of [all, deleted]) {
    if (result.exitCode !== 0) {
      invalid(`Unable to inspect repository changes: ${result.stderr.trim() || "git diff failed"}.`);
    }
  }
  return Object.freeze({
    paths: Object.freeze(
      [...new Set(parseNullDelimited(all.stdout, "changed-path"))].toSorted(
        comparePaths
      )
    ),
    deletedPaths: Object.freeze(
      [...new Set(parseNullDelimited(deleted.stdout, "deleted-path"))].toSorted(
        comparePaths
      )
    )
  });
}

async function changedPathGroups(execute: ExecuteWorkflowProcess,
  root: string,
  baseline: BaselineResolution,
  signal?: AbortSignal
): Promise<RepositoryChangeGroups> {
  const committed = baseline.baselineCommit === null || baseline.headCommit === null
    ? Object.freeze({ paths: Object.freeze([]), deletedPaths: Object.freeze([]) })
    : await diffGroup(execute,
        root,
        [`${baseline.baselineCommit}..${baseline.headCommit}`],
        signal
      );
  const [staged, unstaged, untrackedResult] = await Promise.all([
    diffGroup(execute, root, ["--cached"], signal),
    diffGroup(execute, root, [], signal),
    git(execute,
      root,
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      signal
    )
  ]);
  if (untrackedResult.exitCode !== 0) {
    invalid(
      `Unable to inspect repository changes: ${untrackedResult.stderr.trim() || "git ls-files failed"}.`
    );
  }
  const untracked = Object.freeze({
    paths: Object.freeze(
      [...new Set(parseNullDelimited(untrackedResult.stdout, "untracked-path"))].toSorted(
        comparePaths
      )
    ),
    deletedPaths: Object.freeze([])
  });
  return Object.freeze({ committed, staged, unstaged, untracked });
}

async function scopeDigest(
  baseline: BaselineResolution,
  groups: RepositoryChangeGroups
): Promise<string> {
  const payload = JSON.stringify({
    protocol: "agent-teams-foundation.changed-scope-evidence.v1",
    requestedBaseRef: baseline.requestedRef,
    resolvedBaseRef: baseline.resolvedRef,
    baseCommit: baseline.baseCommit,
    headRef: "HEAD",
    headCommit: baseline.headCommit,
    mergeBaseCommit: baseline.mergeBaseCommit,
    changeGroups: groups
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload)
  );
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

export class GitRepositoryChangesReader implements RepositoryChangesReader {
  constructor(private readonly execute: ExecuteWorkflowProcess) {}

  async collect(input: {
    readonly consumerRoot: string;
    readonly baseRef?: string;
    readonly signal?: AbortSignal;
  }) {
    const execute = this.execute;
    if (input.baseRef !== undefined && input.baseRef.startsWith("-")) {
      invalid("The base ref cannot start with a dash.");
    }
    const root = await realpath(input.consumerRoot).catch(() =>
      invalid("The consumer root is unavailable.")
    );
    const topLevel = await git(execute,
      root,
      ["rev-parse", "--show-toplevel"],
      input.signal
    );
    if (topLevel.exitCode !== 0) {
      invalid("The consumer root must be a Git repository.");
    }
    const gitRoot = await realpath(topLevel.stdout.trim());
    if (gitRoot !== root) {
      invalid("The consumer root must be the Git repository root.");
    }
    const baseline = await resolveBaseline(execute, root, input.baseRef, input.signal);
    const changeGroups = await changedPathGroups(execute, root, baseline, input.signal);
    const groups: readonly RepositoryChangeGroup[] = [
      changeGroups.committed,
      changeGroups.staged,
      changeGroups.unstaged,
      changeGroups.untracked
    ];
    const changedPaths = [
      ...new Set(groups.flatMap(({ paths }) => paths))
    ].toSorted(comparePaths);
    const deletedPaths = [
      ...new Set(groups.flatMap(({ deletedPaths: paths }) => paths))
    ].toSorted(comparePaths);
    [...changedPaths, ...deletedPaths].forEach(assertSafeRepositoryPath);
    return Object.freeze({
      baselineRef: baseline.baselineRef,
      baselineCommit: baseline.baselineCommit,
      requestedBaseRef: baseline.requestedRef,
      resolvedBaseRef: baseline.resolvedRef,
      baseCommit: baseline.baseCommit,
      headRef: "HEAD" as const,
      headCommit: baseline.headCommit,
      mergeBaseCommit: baseline.mergeBaseCommit,
      changeGroups,
      scopeDigest: await scopeDigest(baseline, changeGroups),
      changedPaths: Object.freeze(changedPaths),
      deletedPaths: Object.freeze(deletedPaths),
      existingPaths: await existingFiles(root, changedPaths)
    });
  }
}

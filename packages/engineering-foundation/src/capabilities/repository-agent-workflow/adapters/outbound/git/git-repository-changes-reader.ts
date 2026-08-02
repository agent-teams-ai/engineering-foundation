import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { FoundationError } from "../../../../../errors.js";
import type { RepositoryChangesReader } from "../../../application/ports/changed-workflow.js";
import { execute } from "../process/process-execution.js";

const AUTO_BASE_REFS = ["origin/main", "origin/master", "main", "master"] as const;

function invalid(message: string): never {
  throw new FoundationError("CONSUMER_INVALID", message);
}

function parseNullDelimited(value: string): readonly string[] {
  return value
    .split("\0")
    .filter((path) => path.length > 0);
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

async function git(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal
) {
  return execute("git", args, { cwd, ...(signal === undefined ? {} : { signal }) });
}

async function resolveBaseline(
  root: string,
  requested: string | undefined,
  signal?: AbortSignal
): Promise<{ readonly ref: string; readonly commit: string | null }> {
  const head = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  if (head.exitCode !== 0) {
    if (requested !== undefined) {
      invalid("An explicit base cannot be resolved before the repository has an initial commit.");
    }
    return { ref: "unborn-head", commit: null };
  }
  const candidates = requested === undefined ? AUTO_BASE_REFS : [requested];
  for (const candidate of candidates) {
    const resolved = await git(root, ["rev-parse", "--verify", `${candidate}^{commit}`], signal);
    if (resolved.exitCode !== 0) {
      continue;
    }
    const mergeBase = await git(
      root,
      ["merge-base", "HEAD", resolved.stdout.trim()],
      signal
    );
    if (mergeBase.exitCode === 0 && mergeBase.stdout.trim().length > 0) {
      return { ref: candidate, commit: mergeBase.stdout.trim() };
    }
  }
  if (requested !== undefined) {
    invalid(`Unable to resolve an exact merge base for ${requested}.`);
  }
  return { ref: "HEAD", commit: head.stdout.trim() };
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

async function changedPathGroups(
  root: string,
  baselineCommit: string | null,
  signal?: AbortSignal
): Promise<readonly (readonly string[])[]> {
  const common = [
    "--no-renames",
    "--name-only",
    "--diff-filter=ACMRDTUXB",
    "-z"
  ] as const;
  const commands: readonly (readonly string[])[] = [
    ...(baselineCommit === null
      ? []
      : [["diff", ...common, `${baselineCommit}..HEAD`] as const]),
    ["diff", ...common],
    ["diff", "--cached", ...common],
    ["ls-files", "--others", "--exclude-standard", "-z"]
  ];
  const results = await Promise.all(commands.map((args) => git(root, args, signal)));
  for (const result of results) {
    if (result.exitCode !== 0) {
      invalid(`Unable to inspect repository changes: ${result.stderr.trim() || "git failed"}.`);
    }
  }
  return results.map(({ stdout }) => parseNullDelimited(stdout));
}

export class GitRepositoryChangesReader implements RepositoryChangesReader {
  async collect(input: {
    readonly consumerRoot: string;
    readonly baseRef?: string;
    readonly signal?: AbortSignal;
  }) {
    if (input.baseRef !== undefined && input.baseRef.startsWith("-")) {
      invalid("The base ref cannot start with a dash.");
    }
    const root = await realpath(input.consumerRoot).catch(() =>
      invalid("The consumer root is unavailable.")
    );
    const topLevel = await git(root, ["rev-parse", "--show-toplevel"], input.signal);
    if (topLevel.exitCode !== 0) {
      invalid("The consumer root must be a Git repository.");
    }
    const gitRoot = await realpath(topLevel.stdout.trim());
    if (gitRoot !== root) {
      invalid("The consumer root must be the Git repository root.");
    }
    const baseline = await resolveBaseline(root, input.baseRef, input.signal);
    const groups = await changedPathGroups(root, baseline.commit, input.signal);
    const changedPaths = [...new Set(groups.flat())].toSorted();
    changedPaths.forEach(assertSafeRepositoryPath);
    return Object.freeze({
      baselineRef: baseline.ref,
      baselineCommit: baseline.commit,
      changedPaths: Object.freeze(changedPaths),
      existingPaths: await existingFiles(root, changedPaths)
    });
  }
}

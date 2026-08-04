import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RELEASE_BRANCH = "changeset-release/main";
const ACCEPTED_ADR_BASELINE_PATH =
  "architecture/decisions/accepted-decisions.json";
const LEGACY_ADR_ROOT = "docs/decisions";
const RELEASE_OWNED_PREFIXES = [
  "architecture/contracts/",
  "architecture/public-api/",
];
const ADR_ID = /^ADR-\d{4}$/u;
const IMMUTABLE_DIGEST = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, expected) {
  return Object.keys(value).every((key) => expected.includes(key));
}

function isRepositoryMarkdownPath(value) {
  return (
    value.endsWith(".md") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
  );
}

function isValidAcceptedAdrEntry(candidate, ids, paths) {
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["id", "path", "immutableDigest"])) {
    return false;
  }
  if (typeof candidate.id !== "string" || !ADR_ID.test(candidate.id)) {
    return false;
  }
  if (typeof candidate.path !== "string" || !isRepositoryMarkdownPath(candidate.path)) {
    return false;
  }
  if (
    typeof candidate.immutableDigest !== "string" ||
    !IMMUTABLE_DIGEST.test(candidate.immutableDigest)
  ) {
    return false;
  }
  return !ids.has(candidate.id) && !paths.has(candidate.path);
}

function parseAcceptedAdrBaseline(source, revision) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(
      `Accepted ADR baseline at ${revision} is not valid JSON.`,
    );
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.algorithm !== "sha256" ||
    !Array.isArray(value.decisions) ||
    !hasOnlyKeys(value, ["schemaVersion", "algorithm", "decisions"])
  ) {
    throw new Error(
      `Accepted ADR baseline at ${revision} does not match the immutable baseline shape.`,
    );
  }

  const ids = new Set();
  const paths = new Set();
  const entries = [];
  for (const candidate of value.decisions) {
    if (!isValidAcceptedAdrEntry(candidate, ids, paths)) {
      throw new Error(
        `Accepted ADR baseline at ${revision} contains an invalid or duplicate entry.`,
      );
    }
    entries.push({
      id: candidate.id,
      immutableDigest: candidate.immutableDigest,
      path: candidate.path,
    });
    ids.add(candidate.id);
    paths.add(candidate.path);
  }
  if (
    entries.some(
      (entry, index) => index > 0 && entries[index - 1].id >= entry.id,
    )
  ) {
    throw new Error(
      `Accepted ADR baseline at ${revision} must be sorted by unique ADR ID.`,
    );
  }
  return entries;
}

/**
 * Compares the immutable history that existed before a pull request with the
 * proposed checkout. New entries are allowed, but a historical entry cannot
 * disappear or change identity. The normal governance capability, which runs
 * immediately before this script, verifies that HEAD's documents match its
 * retained digests.
 */
export function acceptedAdrHistoryViolations(previousSource, currentSource) {
  if (previousSource === null) {
    return [];
  }
  const previous = parseAcceptedAdrBaseline(previousSource, "merge base");
  if (currentSource === null) {
    return [
      `Accepted ADR history baseline ${ACCEPTED_ADR_BASELINE_PATH} was deleted.`,
    ];
  }
  const current = parseAcceptedAdrBaseline(currentSource, "HEAD");
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  const violations = [];
  for (const historical of previous) {
    const candidate = currentById.get(historical.id);
    if (candidate === undefined) {
      violations.push(`Accepted ADR history entry ${historical.id} was deleted.`);
      continue;
    }
    if (
      candidate.path !== historical.path ||
      candidate.immutableDigest !== historical.immutableDigest
    ) {
      violations.push(`Accepted ADR history entry ${historical.id} was rewritten.`);
    }
  }
  return violations.toSorted();
}

async function gitOutput(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    throw new Error(
      `Unable to read Git evidence for accepted ADR history${detail.length === 0 ? "." : `: ${detail}`}`,
      { cause: error },
    );
  }
}

async function gitFileAtRevision(cwd, revision, path) {
  try {
    return await gitOutput(cwd, ["show", `${revision}:${path}`]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (/exists on disk, but not in|does not exist in|path .* does not exist/u.test(detail)) {
      return null;
    }
    throw error;
  }
}

function normalizedSource(source) {
  return source.replace(/\r\n/g, "\n");
}

function sourceWithoutLeadingFrontmatter(source) {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/u, "");
}

function isLegacyAcceptedAdr(source) {
  return (
    /^# ADR-\d{4}: /mu.test(source) &&
    /^Status: (?:Accepted|Superseded)\s*$/mu.test(source)
  );
}

async function legacyAcceptedAdrSources(cwd, revision) {
  const paths = (await gitOutput(cwd, [
    "ls-tree",
    "-r",
    "--name-only",
    revision,
    "--",
    LEGACY_ADR_ROOT,
  ]))
    .split(/\r?\n/u)
    .filter((path) => path.endsWith(".md"))
    .toSorted();
  const entries = await Promise.all(
    paths.map(async (path) => ({
      path,
      source: await gitFileAtRevision(cwd, revision, path),
    })),
  );
  return entries.filter(
    (entry) => entry.source !== null && isLegacyAcceptedAdr(entry.source),
  );
}

async function acceptedAdrBootstrapViolations(input) {
  if (input.previousBaselineSource !== null || input.currentBaselineSource === null) {
    return [];
  }
  const historical = await legacyAcceptedAdrSources(input.cwd, input.mergeBase);
  const current = await Promise.all(
    historical.map(async (entry) => ({
      ...entry,
      currentSource: await gitFileAtRevision(input.cwd, input.headReference, entry.path),
    })),
  );
  return current
    .flatMap((entry) => {
      if (entry.currentSource === null) {
        return [`Legacy accepted ADR ${entry.path} was deleted during baseline initialization.`];
      }
      return normalizedSource(sourceWithoutLeadingFrontmatter(entry.currentSource)) ===
        normalizedSource(entry.source)
        ? []
        : [`Legacy accepted ADR ${entry.path} was rewritten during baseline initialization.`];
    })
    .toSorted();
}

export async function acceptedAdrHistoryViolationsAtMergeBase({
  baseReference,
  cwd = process.cwd(),
  headReference = "HEAD",
}) {
  const mergeBase = (
    await gitOutput(cwd, ["merge-base", baseReference, headReference])
  ).trim();
  if (!/^[0-9a-f]{40}$/u.test(mergeBase)) {
    throw new Error("Git merge-base did not return an immutable commit identifier.");
  }
  const [previousSource, currentSource] = await Promise.all([
    gitFileAtRevision(cwd, mergeBase, ACCEPTED_ADR_BASELINE_PATH),
    gitFileAtRevision(cwd, headReference, ACCEPTED_ADR_BASELINE_PATH),
  ]);
  const [historyViolations, bootstrapViolations] = await Promise.all([
    acceptedAdrHistoryViolations(previousSource, currentSource),
    acceptedAdrBootstrapViolations({
      currentBaselineSource: currentSource,
      cwd,
      headReference,
      mergeBase,
      previousBaselineSource: previousSource,
    }),
  ]);
  return [...historyViolations, ...bootstrapViolations].toSorted();
}

function protectedPaths(change) {
  return change.status === "R" && change.previousPath !== undefined
    ? [change.previousPath, change.path]
    : [change.path];
}

export function releaseOwnedFileViolations(
  changes,
  headReference,
  headRepository,
  baseRepository,
) {
  if (
    headReference === RELEASE_BRANCH &&
    headRepository !== undefined &&
    headRepository === baseRepository
  ) {
    return [];
  }
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.status === "A" || change.status === "C"
          ? []
          : protectedPaths(change).filter((path) =>
              RELEASE_OWNED_PREFIXES.some((prefix) => path.startsWith(prefix)),
            ),
      ),
    ),
  ].toSorted();
}

async function changedPullRequestPaths() {
  const base = process.env.GITHUB_BASE_REF;
  if (base === undefined || !/^[A-Za-z0-9._/-]+$/u.test(base)) {
    throw new Error("GITHUB_BASE_REF is missing or invalid for pull-request policy.");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-status", "--diff-filter=ACMRTD", `origin/${base}...HEAD`, "--"],
    { encoding: "utf8" }
  );
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const status = fields[0]?.slice(0, 1);
      const path = fields.at(-1);
      const renamedOrCopied = status === "R" || status === "C";
      const previousPath = renamedOrCopied ? fields[1] : undefined;
      if (
        status === undefined ||
        path === undefined ||
        (renamedOrCopied && previousPath === undefined)
      ) {
        throw new Error(`Cannot parse git change evidence: ${line}.`);
      }
      return {
        status,
        path,
        ...(previousPath === undefined ? {} : { previousPath }),
      };
    });
}

async function main() {
  const base = process.env.GITHUB_BASE_REF;
  if (base === undefined || !/^[A-Za-z0-9._/-]+$/u.test(base)) {
    throw new Error("GITHUB_BASE_REF is missing or invalid for pull-request policy.");
  }
  const [releaseOwnedViolations, historyViolations] = await Promise.all([
    changedPullRequestPaths().then((changes) =>
      releaseOwnedFileViolations(
        changes,
        process.env.GITHUB_HEAD_REF ?? "",
        process.env.FOUNDATION_PR_HEAD_REPOSITORY,
        process.env.GITHUB_REPOSITORY,
      ),
    ),
    acceptedAdrHistoryViolationsAtMergeBase({
      baseReference: `origin/${base}`,
    }),
  ]);
  const violations = [...releaseOwnedViolations, ...historyViolations].toSorted();
  if (violations.length > 0) {
    throw new Error(
      `Release-owned or accepted-ADR history policy failed: ${violations.join(", ")}.`
    );
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === resolve(invokedPath) &&
  process.env.GITHUB_EVENT_NAME === "pull_request"
) {
  await main();
}

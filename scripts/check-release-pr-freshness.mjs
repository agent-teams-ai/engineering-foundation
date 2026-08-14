import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";

import { readStreamText } from "./check-release-pr-files.mjs";
import {
  PUBLISHABLE_PACKAGES,
  publishablePackageByName,
} from "./publishable-packages.mjs";

const execFileAsync = promisify(execFile);
const EXACT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RELEASE_TYPES = new Set(["patch", "minor", "major"]);

function exactSha(value, label) {
  if (typeof value !== "string" || !EXACT_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact 40-character lowercase commit SHA`);
  }
  return value;
}

function exactPullRequestNumber(value, label) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9]\d*$/u.test(normalized)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function canonicalMarkdown(value) {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function searchableMarkdown(value) {
  return canonicalMarkdown(value).replaceAll(/\s+/gu, " ");
}

function pullRequestField(pullRequest, directName, ownerName, nestedName) {
  const direct = pullRequest?.[directName];
  return direct === undefined ? pullRequest?.[ownerName]?.[nestedName] : direct;
}

function normalizePullRequest(pullRequest) {
  const normalized = {
    number: exactPullRequestNumber(pullRequest?.number, "pull request number"),
    state: pullRequest?.state,
    headRef: pullRequestField(pullRequest, "headRef", "head", "ref"),
    headSha: pullRequestField(pullRequest, "headSha", "head", "sha"),
    baseRef: pullRequestField(pullRequest, "baseRef", "base", "ref"),
    baseSha: pullRequestField(pullRequest, "baseSha", "base", "sha"),
    body: pullRequest?.body,
  };
  const { number, ...textFields } = normalized;
  for (const [name, value] of Object.entries(textFields)) {
    if (typeof value !== "string") {
      throw new Error(`pull request ${name} must be a string`);
    }
  }
  return { number, ...textFields };
}

function parseChangeset(path, source) {
  const normalized = source.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(normalized);
  if (match === null) {
    throw new Error(`${path} must contain YAML frontmatter and a non-empty summary`);
  }
  const releases = parseYaml(match[1]);
  if (releases === null || typeof releases !== "object" || Array.isArray(releases)) {
    throw new Error(`${path} frontmatter must be a package-to-release-type mapping`);
  }
  const packageReleases = Object.entries(releases)
    .filter(
      ([packageName, releaseType]) =>
        publishablePackageByName(packageName) !== undefined &&
        RELEASE_TYPES.has(releaseType),
    )
    .map(([packageName, releaseType]) => ({ packageName, releaseType }));
  if (packageReleases.length === 0) {
    return null;
  }
  const summary = match[2].trim();
  if (summary.length === 0) {
    throw new Error(`${path} must contain a non-empty summary`);
  }
  return { path, releases: packageReleases, summary };
}

function generatedReleaseBody(baseChangelog, headChangelog, packageName, version) {
  const base = baseChangelog.replaceAll("\r\n", "\n");
  const head = headChangelog.replaceAll("\r\n", "\n");
  const titleEnd = base.indexOf("\n\n") + 2;
  if (titleEnd < 2) {
    throw new Error("base changelog must have a Markdown title");
  }
  const title = base.slice(0, titleEnd);
  const history = base.slice(titleEnd);
  if (!head.startsWith(title) || !head.endsWith(history)) {
    throw new Error("release changelog must preserve its title and previous history");
  }
  const insertedEnd = head.length - history.length;
  const inserted = head.slice(title.length, insertedEnd).trim();
  const heading = `## ${version}`;
  if (inserted !== heading && !inserted.startsWith(`${heading}\n`)) {
    throw new Error(`generated changelog insertion must start with ${heading}`);
  }
  return `# Releases\n${inserted.replace(heading, `## ${packageName}@${version}`)}`;
}

function releaseBody(body) {
  const normalized = body.replaceAll("\r\n", "\n");
  const match = /^# Releases\s*$/gmu;
  let start;
  for (const result of normalized.matchAll(match)) {
    start = result.index;
  }
  if (start === undefined) {
    throw new Error("pull request body does not contain a # Releases section");
  }
  return normalized.slice(start);
}

async function git(cwd, args, options = {}) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
    ...options,
  });
}

async function fileAtRevision(cwd, revision, path) {
  const { stdout } = await git(cwd, ["show", `${revision}:${path}`]);
  return stdout;
}

async function pathExistsAtRevision(cwd, revision, path) {
  try {
    await git(cwd, ["cat-file", "-e", `${revision}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

async function prereleaseState(cwd, revision) {
  const path = ".changeset/pre.json";
  if (!(await pathExistsAtRevision(cwd, revision, path))) {
    return;
  }
  const state = JSON.parse(await fileAtRevision(cwd, revision, path));
  if (
    state === null ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    (state.mode !== "pre" && state.mode !== "exit") ||
    typeof state.tag !== "string" ||
    !/^[0-9A-Za-z-]+$/u.test(state.tag) ||
    !Array.isArray(state.changesets) ||
    state.changesets.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new Error(`${path} must contain a valid Changesets prerelease state`);
  }
  return {
    mode: state.mode,
    tag: state.tag,
    changesets: new Set(state.changesets),
  };
}

function changesetId(path) {
  return basename(path, ".md");
}

async function expectedChangesets(cwd, revision) {
  const { stdout } = await git(cwd, [
    "ls-tree",
    "-r",
    "--name-only",
    revision,
    "--",
    ".changeset",
  ]);
  const paths = stdout
    .split("\n")
    .filter(
      (path) =>
        /^\.changeset\/[^/]+\.md$/u.test(path) && path !== ".changeset/README.md",
    );
  const prerelease = await prereleaseState(cwd, revision);
  const changesets = await Promise.all(
    paths.map(async (path) => parseChangeset(path, await fileAtRevision(cwd, revision, path))),
  );
  return changesets.filter(
    (changeset) =>
      changeset !== null &&
      (prerelease?.mode === "exit" ||
        !prerelease?.changesets.has(changesetId(changeset.path))),
  );
}

function stableExitVersion(baseVersion, state) {
  if (state?.mode !== "exit" || typeof baseVersion !== "string") {
    return;
  }
  const escapedTag = state.tag.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))-${escapedTag}\\.(?:0|[1-9]\\d*)$`,
    "u",
  ).exec(baseVersion);
  return match?.[1];
}

function optionalExactSha(value, label) {
  return value === undefined ? undefined : exactSha(value, label);
}

function releaseRevisionBindingViolations(pullRequest, evidence) {
  const violations = [];
  const expectedHeadSha = optionalExactSha(
    evidence.expectedHeadSha,
    "expected pull request head",
  );
  const expectedBaseSha = optionalExactSha(
    evidence.expectedBaseSha,
    "expected pull request base",
  );
  const expectedPullRequestNumber =
    evidence.expectedPullRequestNumber === undefined
      ? undefined
      : exactPullRequestNumber(
          evidence.expectedPullRequestNumber,
          "expected pull request number",
        );
  if (expectedHeadSha !== undefined && pullRequest.headSha !== expectedHeadSha) {
    violations.push("release pull request head changed during attestation");
  }
  if (expectedBaseSha !== undefined && pullRequest.baseSha !== expectedBaseSha) {
    violations.push("release pull request base changed during attestation");
  }
  if (
    expectedPullRequestNumber !== undefined &&
    pullRequest.number !== expectedPullRequestNumber
  ) {
    violations.push("release pull request number changed during attestation");
  }
  return violations;
}

function pullRequestShapeViolations(
  pullRequest,
  { currentMainSha, processedMainSha, baseSha },
) {
  const violations = [];
  if (pullRequest.state !== "open") {
    violations.push("release pull request must be open");
  }
  if (pullRequest.headRef !== "changeset-release/main") {
    violations.push("release pull request must use changeset-release/main as its head");
  }
  if (pullRequest.baseRef !== "main") {
    violations.push("release pull request must target main");
  }
  if (currentMainSha !== processedMainSha) {
    violations.push("processed main is stale relative to the current main reference");
  }
  if (baseSha !== processedMainSha) {
    violations.push("release pull request base is not the processed main revision");
  }
  return violations;
}

function prereleaseTransitionViolations(basePrerelease, headPrerelease) {
  if (basePrerelease?.mode === "pre" && headPrerelease?.mode !== "pre") {
    return ["release head must preserve active Changesets prerelease state"];
  }
  if (basePrerelease?.mode === "exit" && headPrerelease !== undefined) {
    return ["release head must remove Changesets state when completing prerelease exit"];
  }
  if (basePrerelease === undefined && headPrerelease !== undefined) {
    return ["release head cannot introduce Changesets prerelease state"];
  }
  return [];
}

function stableExitViolations(basePrerelease, baseVersion, headVersion) {
  if (basePrerelease?.mode !== "exit") {
    return [];
  }
  const expectedVersion = stableExitVersion(baseVersion, basePrerelease);
  return expectedVersion === undefined || headVersion !== expectedVersion
    ? ["prerelease exit must publish the exact stable version of the processed prerelease"]
    : [];
}

async function changesetConsumptionViolations(cwd, headSha, changesets) {
  const headPrereleaseChangesets = await prereleaseState(cwd, headSha);
  const violations = [];
  for (const changeset of changesets) {
    if (
      (await pathExistsAtRevision(cwd, headSha, changeset.path)) &&
      !headPrereleaseChangesets?.changesets.has(changesetId(changeset.path))
    ) {
      violations.push(`release head did not consume ${changeset.path}`);
    }
  }
  return violations;
}

function missingSummaryViolations(releasePackage, generatedRelease, changesets) {
  let unmatchedRelease = searchableMarkdown(generatedRelease);
  const violations = [];
  for (const changeset of changesets.toSorted(
    (left, right) => right.summary.length - left.summary.length,
  )) {
    const summary = searchableMarkdown(changeset.summary);
    const index = unmatchedRelease.indexOf(summary);
    if (index === -1) {
      violations.push(
        `${releasePackage.name} changelog is missing the summary from ${changeset.path}`,
      );
      continue;
    }
    unmatchedRelease =
      unmatchedRelease.slice(0, index) +
      " ".repeat(summary.length) +
      unmatchedRelease.slice(index + summary.length);
  }
  return violations;
}

async function packageReleaseSection(
  cwd,
  baseSha,
  headSha,
  basePrerelease,
  releasePackage,
  changesets,
) {
  if (
    !(await pathExistsAtRevision(cwd, baseSha, releasePackage.manifestPath)) ||
    !(await pathExistsAtRevision(cwd, headSha, releasePackage.manifestPath))
  ) {
    return;
  }
  const [baseManifestText, manifestText, baseChangelog, headChangelog] =
    await Promise.all([
      fileAtRevision(cwd, baseSha, releasePackage.manifestPath),
      fileAtRevision(cwd, headSha, releasePackage.manifestPath),
      fileAtRevision(cwd, baseSha, releasePackage.changelogPath),
      fileAtRevision(cwd, headSha, releasePackage.changelogPath),
    ]);
  const baseManifest = JSON.parse(baseManifestText);
  const manifest = JSON.parse(manifestText);
  if (baseManifest.version === manifest.version) {
    return;
  }
  if (
    manifest.name !== releasePackage.name ||
    typeof baseManifest.version !== "string" ||
    typeof manifest.version !== "string"
  ) {
    return {
      name: releasePackage.name,
      section: undefined,
      violations: [
        `release head package manifest has an unexpected name or version: ${releasePackage.name}`,
      ],
    };
  }
  const generatedRelease = generatedReleaseBody(
    baseChangelog,
    headChangelog,
    manifest.name,
    manifest.version,
  );
  const packageChangesets = changesets.filter((changeset) =>
    changeset.releases.some(
      (release) => release.packageName === releasePackage.name,
    ),
  );
  return {
    name: releasePackage.name,
    section: releaseSections(generatedRelease).get(releasePackage.name),
    violations: [
      ...stableExitViolations(
        basePrerelease,
        baseManifest.version,
        manifest.version,
      ).map((violation) => `${releasePackage.name}: ${violation}`),
      ...missingSummaryViolations(
        releasePackage,
        generatedRelease,
        packageChangesets,
      ),
    ],
  };
}

async function releaseSectionViolations(
  cwd,
  baseSha,
  headSha,
  basePrerelease,
  body,
  changesets,
) {
  let actualSections;
  try {
    actualSections = releaseSections(body);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const results = (
    await Promise.all(
      PUBLISHABLE_PACKAGES.map((releasePackage) =>
        packageReleaseSection(
          cwd,
          baseSha,
          headSha,
          basePrerelease,
          releasePackage,
          changesets,
        ),
      ),
    )
  ).filter((result) => result !== undefined);
  const expectedSections = new Map(
    results
      .filter((result) => result.section !== undefined)
      .map((result) => [result.name, result.section]),
  );
  const violations = results.flatMap((result) => result.violations);
  for (const changeset of changesets) {
    for (const release of changeset.releases) {
      if (!expectedSections.has(release.packageName)) {
        violations.push(
          `release head did not version ${release.packageName} for ${changeset.path}`,
        );
      }
    }
  }
  if (
    actualSections.size !== expectedSections.size ||
    [...expectedSections].some(
      ([packageName, section]) =>
        canonicalMarkdown(actualSections.get(packageName) ?? "") !==
        canonicalMarkdown(section),
    )
  ) {
    violations.push(
      "pull request release body does not exactly match all generated changelog entries",
    );
  }
  return violations;
}

export async function releasePullRequestFreshnessViolations(
  evidence,
  { cwd = process.cwd() } = {},
) {
  const violations = [];
  const processedMainSha = exactSha(evidence.processedMainSha, "processed main");
  const currentMainSha = exactSha(evidence.currentMainSha, "current main");
  const pullRequest = normalizePullRequest(evidence.pullRequest);
  const headSha = exactSha(pullRequest.headSha, "pull request head");
  const baseSha = exactSha(pullRequest.baseSha, "pull request base");
  violations.push(...releaseRevisionBindingViolations(pullRequest, evidence));
  violations.push(
    ...pullRequestShapeViolations(pullRequest, {
      currentMainSha,
      processedMainSha,
      baseSha,
    }),
  );
  const { stdout: parentLine } = await git(cwd, ["rev-list", "--parents", "-n", "1", headSha]);
  const [, ...parents] = parentLine.trim().split(/\s+/u);
  if (parents.length !== 1 || parents[0] !== processedMainSha) {
    violations.push("release head must have exactly the processed main revision as its parent");
  }

  const [basePrerelease, headPrerelease] = await Promise.all([
    prereleaseState(cwd, processedMainSha),
    prereleaseState(cwd, headSha),
  ]);
  violations.push(
    ...prereleaseTransitionViolations(basePrerelease, headPrerelease),
  );

  const changesets = await expectedChangesets(cwd, processedMainSha);
  if (changesets.length === 0) {
    violations.push("processed main must contain at least one package release changeset");
  }
  violations.push(
    ...(await changesetConsumptionViolations(cwd, headSha, changesets)),
    ...(await releaseSectionViolations(
      cwd,
      processedMainSha,
      headSha,
      basePrerelease,
      pullRequest.body,
      changesets,
    )),
  );
  return violations;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const input = JSON.parse(await readStreamText(process.stdin));
  input.processedMainSha = argumentValue("--processed-main") ?? input.processedMainSha;
  const violations = await releasePullRequestFreshnessViolations(input);
  if (violations.length > 0) {
    throw new Error(violations.join("\n"));
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  await main();
}

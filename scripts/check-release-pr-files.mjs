import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CHANGESET_PATTERN = /^\.changeset\/[^/]+\.md$/u;
const CONTRACT_BASELINE_PATTERN =
  /^architecture\/contracts\/(?:(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:json|ya?ml)$/u;
const PUBLIC_API_PATTERN = /^architecture\/public-api\/[^/]+\.json$/u;
const PRERELEASE_STATE = ".changeset/pre.json";
const PACKAGE_MANIFEST = "packages/engineering-foundation/package.json";
const PACKAGE_CHANGELOG = "packages/engineering-foundation/CHANGELOG.md";

export async function readStreamText(stream) {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return text;
}

function semanticVersion(value) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
      value,
    );
  if (match === null) {
    return;
  }
  const prerelease = match[4]?.split(".");
  if (prerelease?.some((part) => /^\d+$/u.test(part) && /^0\d/u.test(part))) {
    return;
  }
  return {
    core: match.slice(1, 4).map((part) => BigInt(part)),
    prerelease,
  };
}

function comparePrereleaseIdentifiers(base, head) {
  for (let index = 0; index < Math.max(base.length, head.length); index += 1) {
    if (base[index] === undefined) {
      return 1;
    }
    if (head[index] === undefined) {
      return -1;
    }
    if (base[index] === head[index]) {
      continue;
    }
    const baseNumeric = /^\d+$/u.test(base[index]);
    const headNumeric = /^\d+$/u.test(head[index]);
    if (baseNumeric && headNumeric) {
      return BigInt(head[index]) > BigInt(base[index]) ? 1 : -1;
    }
    if (baseNumeric !== headNumeric) {
      return headNumeric ? -1 : 1;
    }
    return head[index] > base[index] ? 1 : -1;
  }
  return 0;
}

function isNewerVersion(baseVersion, headVersion) {
  const base = semanticVersion(baseVersion);
  const head = semanticVersion(headVersion);
  if (base === undefined || head === undefined) {
    return false;
  }
  for (let index = 0; index < base.core.length; index += 1) {
    if (base.core[index] !== head.core[index]) {
      return head.core[index] > base.core[index];
    }
  }
  if (base.prerelease === undefined) {
    return false;
  }
  if (head.prerelease === undefined) {
    return true;
  }
  return comparePrereleaseIdentifiers(base.prerelease, head.prerelease) > 0;
}

function validPrereleaseState(state, mode = "pre") {
  return (
    state !== null &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    state.mode === mode &&
    typeof state.tag === "string" &&
    /^[0-9A-Za-z-]+$/u.test(state.tag) &&
    state.initialVersions !== null &&
    typeof state.initialVersions === "object" &&
    !Array.isArray(state.initialVersions) &&
    Array.isArray(state.changesets) &&
    state.changesets.every(
      (id) => typeof id === "string" && /^[A-Za-z0-9_-]+$/u.test(id),
    ) &&
    new Set(state.changesets).size === state.changesets.length
  );
}

function stableExitVersion(baseVersion, state) {
  const version = semanticVersion(baseVersion);
  return validPrereleaseState(state, "exit") &&
    version?.prerelease?.length === 2 &&
    version.prerelease[0] === state.tag &&
    /^\d+$/u.test(version.prerelease[1])
    ? version.core.join(".")
    : undefined;
}

function prereleaseStateViolations(baseState, headState, baseVersion, headVersion) {
  if (baseState === undefined && headState === undefined) {
    return [];
  }
  if (validPrereleaseState(baseState, "exit") && headState === undefined) {
    return stableExitVersion(baseVersion, baseState) === headVersion
      ? []
      : ["prerelease exit must publish the exact stable version and remove its state"];
  }
  if (!validPrereleaseState(baseState) || !validPrereleaseState(headState)) {
    return ["release pull request must preserve a valid Changesets prerelease state"];
  }
  const normalizedBase = structuredClone(baseState);
  const normalizedHead = structuredClone(headState);
  const baseChangesets = new Set(normalizedBase.changesets);
  const headChangesets = new Set(normalizedHead.changesets);
  delete normalizedBase.changesets;
  delete normalizedHead.changesets;
  const stateChanged = !isDeepStrictEqual(normalizedBase, normalizedHead);
  const removed = [...baseChangesets].some((id) => !headChangesets.has(id));
  const added = [...headChangesets].some((id) => !baseChangesets.has(id));
  const version = semanticVersion(headVersion);
  const tagMatches = version?.prerelease?.[0] === headState.tag;
  return stateChanged || removed || !added || !tagMatches
    ? ["release pull request must only append consumed Changesets to matching prerelease state"]
    : [];
}

function isAllowedReleaseFile(file, prereleaseExit) {
  if (file.filename === PRERELEASE_STATE) {
    return file.status === "modified" || (prereleaseExit && file.status === "removed");
  }
  if (CHANGESET_PATTERN.test(file.filename)) {
    return file.status === "removed";
  }
  if (
    PUBLIC_API_PATTERN.test(file.filename) ||
    CONTRACT_BASELINE_PATTERN.test(file.filename)
  ) {
    return file.status === "added" || file.status === "modified";
  }
  if (file.filename === PACKAGE_MANIFEST || file.filename === PACKAGE_CHANGELOG) {
    return file.status === "modified";
  }
  return false;
}

export function releasePullRequestFileViolations(files, { prereleaseExit = false } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return ["release pull request file evidence is empty"];
  }

  const violations = files
    .filter(
      (file) =>
        file === null ||
        typeof file !== "object" ||
        typeof file.filename !== "string" ||
        typeof file.status !== "string" ||
        !isAllowedReleaseFile(file, prereleaseExit),
    )
    .map((file) =>
      file !== null && typeof file === "object" && typeof file.filename === "string"
        ? `release pull request contains forbidden change: ${file.filename}`
        : "release pull request contains malformed file evidence",
    );

  const hasModifiedFile = (filename) =>
    files.some((file) => file?.filename === filename && file.status === "modified");
  if (!hasModifiedFile(PACKAGE_MANIFEST)) {
    violations.push(`release pull request must modify ${PACKAGE_MANIFEST}`);
  }
  if (!hasModifiedFile(PACKAGE_CHANGELOG)) {
    violations.push(`release pull request must modify ${PACKAGE_CHANGELOG}`);
  }
  if (
    !files.some(
      (file) =>
        (CHANGESET_PATTERN.test(file?.filename ?? "") && file.status === "removed") ||
        (file?.filename === PRERELEASE_STATE &&
          (file.status === "modified" || (prereleaseExit && file.status === "removed"))),
    )
  ) {
    violations.push("release pull request must consume at least one Changeset");
  }
  return violations;
}

export function releasePullRequestContentViolations({
  baseManifest,
  headManifest,
  baseChangelog,
  headChangelog,
  basePrereleaseState,
  headPrereleaseState,
}) {
  const violations = [];
  const normalizedBaseManifest = structuredClone(baseManifest);
  const normalizedHeadManifest = structuredClone(headManifest);
  const baseVersion = normalizedBaseManifest.version;
  const headVersion = normalizedHeadManifest.version;
  delete normalizedBaseManifest.version;
  delete normalizedHeadManifest.version;

  if (
    typeof baseVersion !== "string" ||
    typeof headVersion !== "string" ||
    !isNewerVersion(baseVersion, headVersion)
  ) {
    violations.push("release pull request must change the package to a valid new version");
  }
  if (!isDeepStrictEqual(normalizedBaseManifest, normalizedHeadManifest)) {
    violations.push("release pull request may change only package.json version");
  }
  violations.push(
    ...prereleaseStateViolations(
      basePrereleaseState,
      headPrereleaseState,
      baseVersion,
      headVersion,
    ),
  );
  const changelogTitleEnd =
    typeof baseChangelog === "string" ? baseChangelog.indexOf("\n\n") + 2 : 0;
  const changelogTitle =
    changelogTitleEnd >= 2 ? baseChangelog.slice(0, changelogTitleEnd) : undefined;
  const baseChangelogHistory =
    changelogTitle === undefined ? undefined : baseChangelog.slice(changelogTitleEnd);
  if (
    typeof baseChangelog !== "string" ||
    typeof headChangelog !== "string" ||
    headChangelog.length <= baseChangelog.length ||
    changelogTitle === undefined ||
    !changelogTitle.startsWith("# ") ||
    !headChangelog.startsWith(changelogTitle) ||
    !headChangelog.slice(changelogTitle.length).endsWith(baseChangelogHistory)
  ) {
    violations.push(
      "release pull request may only insert a release entry after the unchanged changelog title",
    );
  }
  return violations;
}

function revisionArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${name} must be followed by an exact 40-character commit SHA`);
  }
  return value;
}

async function fileAtRevision(revision, path) {
  const { stdout } = await execFileAsync("git", ["show", `${revision}:${path}`], {
    encoding: "utf8",
  });
  return stdout;
}

async function optionalJsonAtRevision(revision, path) {
  try {
    return JSON.parse(await fileAtRevision(revision, path));
  } catch (error) {
    if (error?.code === 128) {
      return;
    }
    throw error;
  }
}

async function main() {
  const pages = JSON.parse(await readStreamText(process.stdin));
  const files = Array.isArray(pages) ? pages.flat() : pages;
  const baseRevision = revisionArgument("--base");
  const headRevision = revisionArgument("--head");
  const [
    baseManifestText,
    headManifestText,
    baseChangelog,
    headChangelog,
    basePrereleaseState,
    headPrereleaseState,
  ] = await Promise.all([
    fileAtRevision(baseRevision, PACKAGE_MANIFEST),
    fileAtRevision(headRevision, PACKAGE_MANIFEST),
    fileAtRevision(baseRevision, PACKAGE_CHANGELOG),
    fileAtRevision(headRevision, PACKAGE_CHANGELOG),
    optionalJsonAtRevision(baseRevision, PRERELEASE_STATE),
    optionalJsonAtRevision(headRevision, PRERELEASE_STATE),
  ]);
  const violations = [
    ...releasePullRequestFileViolations(files, {
      prereleaseExit: validPrereleaseState(basePrereleaseState, "exit"),
    }),
    ...releasePullRequestContentViolations({
      baseManifest: JSON.parse(baseManifestText),
      headManifest: JSON.parse(headManifestText),
      baseChangelog,
      headChangelog,
      basePrereleaseState,
      headPrereleaseState,
    }),
  ];
  if (violations.length > 0) {
    throw new Error(violations.join("\n"));
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  await main();
}

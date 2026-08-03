import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CHANGESET_PATTERN = /^\.changeset\/[^/]+\.md$/u;
const PUBLIC_API_PATTERN = /^architecture\/public-api\/[^/]+\.json$/u;
const PACKAGE_MANIFEST = "packages/engineering-foundation/package.json";
const PACKAGE_CHANGELOG = "packages/engineering-foundation/CHANGELOG.md";

export async function readStreamText(stream) {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return text;
}

function stableVersionTuple(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  return match === null ? undefined : match.slice(1).map((part) => BigInt(part));
}

function isNewerStableVersion(baseVersion, headVersion) {
  const base = stableVersionTuple(baseVersion);
  const head = stableVersionTuple(headVersion);
  if (base === undefined || head === undefined) {
    return false;
  }
  for (let index = 0; index < base.length; index += 1) {
    if (base[index] !== head[index]) {
      return head[index] > base[index];
    }
  }
  return false;
}

function isAllowedReleaseFile(file) {
  if (CHANGESET_PATTERN.test(file.filename)) {
    return file.status === "removed";
  }
  if (PUBLIC_API_PATTERN.test(file.filename)) {
    return file.status === "added" || file.status === "modified";
  }
  if (file.filename === PACKAGE_MANIFEST || file.filename === PACKAGE_CHANGELOG) {
    return file.status === "modified";
  }
  return false;
}

export function releasePullRequestFileViolations(files) {
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
        !isAllowedReleaseFile(file),
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
  if (!files.some((file) => CHANGESET_PATTERN.test(file?.filename ?? "") && file.status === "removed")) {
    violations.push("release pull request must consume at least one Changeset");
  }
  return violations;
}

export function releasePullRequestContentViolations({
  baseManifest,
  headManifest,
  baseChangelog,
  headChangelog,
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
    !isNewerStableVersion(baseVersion, headVersion)
  ) {
    violations.push("release pull request must change the package to a valid new version");
  }
  if (!isDeepStrictEqual(normalizedBaseManifest, normalizedHeadManifest)) {
    violations.push("release pull request may change only package.json version");
  }
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

async function main() {
  const pages = JSON.parse(await readStreamText(process.stdin));
  const files = Array.isArray(pages) ? pages.flat() : pages;
  const baseRevision = revisionArgument("--base");
  const headRevision = revisionArgument("--head");
  const [baseManifestText, headManifestText, baseChangelog, headChangelog] = await Promise.all([
    fileAtRevision(baseRevision, PACKAGE_MANIFEST),
    fileAtRevision(headRevision, PACKAGE_MANIFEST),
    fileAtRevision(baseRevision, PACKAGE_CHANGELOG),
    fileAtRevision(headRevision, PACKAGE_CHANGELOG),
  ]);
  const violations = [
    ...releasePullRequestFileViolations(files),
    ...releasePullRequestContentViolations({
      baseManifest: JSON.parse(baseManifestText),
      headManifest: JSON.parse(headManifestText),
      baseChangelog,
      headChangelog,
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

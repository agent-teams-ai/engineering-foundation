import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RELEASE_BRANCH = "changeset-release/main";
const RELEASE_OWNED_PREFIXES = ["architecture/public-api/"];

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
  const violations = releaseOwnedFileViolations(
    await changedPullRequestPaths(),
    process.env.GITHUB_HEAD_REF ?? "",
    process.env.FOUNDATION_PR_HEAD_REPOSITORY,
    process.env.GITHUB_REPOSITORY,
  );
  if (violations.length > 0) {
    throw new Error(
      `Release-owned public API baselines changed outside ${RELEASE_BRANCH}: ${violations.join(", ")}.`
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

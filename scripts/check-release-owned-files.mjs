import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RELEASE_BRANCH = "changeset-release/main";
const RELEASE_OWNED_PREFIXES = ["architecture/public-api/"];

export function releaseOwnedFileViolations(changes, headReference) {
  if (headReference === RELEASE_BRANCH) {
    return [];
  }
  return changes
    .filter(({ status, path }) =>
      status !== "A" && RELEASE_OWNED_PREFIXES.some((prefix) => path.startsWith(prefix))
    )
    .map(({ path }) => path);
}

async function changedPullRequestPaths() {
  const base = process.env.GITHUB_BASE_REF;
  if (base === undefined || !/^[A-Za-z0-9._/-]+$/u.test(base)) {
    throw new Error("GITHUB_BASE_REF is missing or invalid for pull-request policy.");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-status", "--diff-filter=ACMRD", `origin/${base}...HEAD`],
    { encoding: "utf8" }
  );
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const status = fields[0]?.slice(0, 1);
      const path = fields.at(-1);
      if (status === undefined || path === undefined) {
        throw new Error(`Cannot parse git change evidence: ${line}.`);
      }
      return { status, path };
    });
}

if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  const violations = releaseOwnedFileViolations(
    await changedPullRequestPaths(),
    process.env.GITHUB_HEAD_REF ?? ""
  );
  if (violations.length > 0) {
    throw new Error(
      `Release-owned public API baselines changed outside ${RELEASE_BRANCH}: ${violations.join(", ")}.`
    );
  }
}

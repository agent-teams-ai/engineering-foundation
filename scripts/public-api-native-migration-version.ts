import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { releasePullRequestFileViolations } from "./check-release-pr-files.mjs";
import { runCommand as executeCommand } from "./pack-test-support.mjs";
import { migrationBytes, migrationDigest } from "./public-api-native-migration.ts";
import { migrationRepository } from "./public-api-native-migration-inputs.ts";
import { nativeMigrationPackageNames } from "./public-api-native-migration-observation.ts";
import { checkFrozenVersionCandidate } from "./release-candidate-host.ts";

// Static views of the existing owned JavaScript helpers, not provider JSON.
const runCommand = executeCommand as (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

function fail(message: string): never {
  throw new Error(`Native migration version workflow: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("expected an observed JSON object");
  }
  return value as Record<string, unknown>;
}
export interface VersionRunIdentity {
  readonly sha: string;
  readonly runId: number;
  readonly attempt: number;
}

/** Necessary caller context only. A successful environment check grants no write authority. */
export function readVersionRunIdentity(
  environment: Readonly<Record<string, string | undefined>>,
): VersionRunIdentity {
  const sha = environment["GITHUB_SHA"];
  const runId = Number(environment["GITHUB_RUN_ID"]);
  const attempt = Number(environment["GITHUB_RUN_ATTEMPT"]);
  if (
    environment["GITHUB_ACTIONS"] !== "true" ||
    environment["GITHUB_REPOSITORY"] !== migrationRepository ||
    environment["GITHUB_EVENT_NAME"] !== "push" ||
    environment["GITHUB_REF"] !== "refs/heads/main" ||
    environment["GITHUB_JOB"] !== "release" ||
    environment["GITHUB_SERVER_URL"] !== "https://github.com" ||
    environment["GITHUB_WORKFLOW_REF"] !==
      `${migrationRepository}/.github/workflows/release.yml@refs/heads/main` ||
    sha === undefined ||
    !/^[a-f0-9]{40}$/u.test(sha) ||
    environment["GITHUB_WORKFLOW_SHA"] !== sha ||
    !/^[1-9][0-9]*$/u.test(environment["GITHUB_RUN_ID"] ?? "") ||
    !Number.isSafeInteger(runId) ||
    !/^[1-9][0-9]*$/u.test(environment["GITHUB_RUN_ATTEMPT"] ?? "") ||
    !Number.isSafeInteger(attempt)
  ) {
    fail("only the existing main release version job may apply baselines");
  }
  return Object.freeze({ sha, runId, attempt });
}

export function assertVersionRunBinding(
  identity: VersionRunIdentity,
  value: unknown,
  mainValue: unknown,
): void {
  const run = object(value);
  const repository = object(run["repository"]);
  const headRepository = object(run["head_repository"]);
  const main = object(mainValue);
  const mainObject = object(main["object"]);
  const matches = {
    "run.id": run["id"] === identity.runId,
    "run.run_attempt": run["run_attempt"] === identity.attempt,
    "run.event": run["event"] === "push",
    "run.head_branch": run["head_branch"] === "main",
    "run.head_sha": run["head_sha"] === identity.sha,
    "run.path": run["path"] === ".github/workflows/release.yml",
    "run.status": run["status"] === "in_progress",
    "run.conclusion": run["conclusion"] === null,
    "run.repository.full_name": repository["full_name"] === migrationRepository,
    "run.head_repository.full_name": headRepository["full_name"] === migrationRepository,
    "run.pull_requests": Array.isArray(run["pull_requests"]) && run["pull_requests"].length === 0,
    "run.html_url":
      run["html_url"] ===
      `https://github.com/${migrationRepository}/actions/runs/${identity.runId}`,
    "main.ref": main["ref"] === "refs/heads/main",
    "main.object.type": mainObject["type"] === "commit",
    "main.object.sha": mainObject["sha"] === identity.sha,
  } satisfies Readonly<Record<string, boolean>>;
  const mismatches = Object.entries(matches)
    .filter(([, matched]) => !matched)
    .map(([field]) => field);
  if (mismatches.length !== 0) {
    const observedStatus = run["status"];
    const observedConclusion = run["conclusion"];
    const status =
      typeof observedStatus === "string" &&
      ["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(
        observedStatus,
      )
        ? observedStatus
        : "unexpected";
    const conclusion =
      observedConclusion === null
        ? "null"
        : typeof observedConclusion === "string" &&
            [
              "success",
              "failure",
              "neutral",
              "cancelled",
              "skipped",
              "timed_out",
              "action_required",
              "stale",
              "startup_failure",
            ].includes(observedConclusion)
          ? observedConclusion
          : "unexpected";
    fail(
      `observed release run or fresh main differs from the invocation; mismatched fields: ${mismatches.join(", ")}; observed status: ${status}; observed conclusion: ${conclusion}`,
    );
  }
}

export interface ReleaseFile {
  readonly filename: string;
  readonly status: string;
}
export function parseVersionFileChanges(text: string): readonly ReleaseFile[] {
  if (!text.endsWith("\0")) {
    fail("malformed tracked file changes");
  }
  const fields = text.slice(0, -1).split("\0");
  if (fields.length % 2 !== 0) {
    fail("malformed tracked file changes");
  }
  return fields.reduce<ReleaseFile[]>((rows, status, index) => {
    if (index % 2 === 0) {
      const filename = fields.at(index + 1)!;
      if (!["M", "D", "A"].includes(status) || filename.length === 0 || filename.includes("\\")) {
        fail("unsupported version file change");
      }
      rows.push({
        filename,
        status: status === "M" ? "modified" : status === "D" ? "removed" : "added",
      });
    }
    return rows;
  }, []);
}

export function assertVersionFiles(files: readonly ReleaseFile[], prereleaseExit: boolean): void {
  const violations = releasePullRequestFileViolations(files, { prereleaseExit });
  const typedAnchors = new Set(
    nativeMigrationPackageNames.map(
      (name) => `architecture/public-api/${name.split("/").at(-1)!}.json`,
    ),
  );
  // An interrupted named migration can leave exact typed postimages. The core
  // must verify their bytes before writing anything; other baseline dirt rejects.
  if (
    files.some(
      (file) => file.filename.startsWith("architecture/") && !typedAnchors.has(file.filename),
    )
  ) {
    violations.push("nonmigration baseline edits are outside the version operation");
  }
  if (violations.length !== 0) {
    fail(violations.join("; "));
  }
}

async function git(root: string, args: readonly string[]): Promise<string> {
  return (await runCommand("git", [...args], root)).stdout;
}
async function baseText(root: string, sha: string, path: string): Promise<string> {
  return git(root, ["show", `${sha}:${path}`]);
}
async function optionalBaseState(root: string, sha: string): Promise<unknown> {
  if ((await git(root, ["ls-tree", sha, "--", ".changeset/pre.json"])).trim() === "") {
    return undefined;
  }
  return JSON.parse(await baseText(root, sha, ".changeset/pre.json")) as unknown;
}
function sameVersionFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    (["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs", "nlink"] as const).every(
      (key) => before[key] === after[key],
    )
  );
}

export async function versionMetadataDigest(path: string): Promise<string> {
  const portableFlags: Partial<Pick<typeof constants, "O_NOFOLLOW" | "O_NONBLOCK">> = constants;
  const file = await open(
    path,
    constants.O_RDONLY | (portableFlags.O_NOFOLLOW ?? 0) | (portableFlags.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = await file.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o111n) !== 0n ||
      !sameVersionFile(metadata, await lstat(path, { bigint: true }))
    ) {
      fail("version metadata must remain ordinary nonexecutable files");
    }
    // Retain readFile's existing 2 GiB ceiling while hashing through a small
    // buffer. A growing file cannot extend the initial observed read bound.
    if (metadata.size >= 2n ** 31n) {
      fail("version metadata exceeds the existing file-read ceiling");
    }
    const maximumRead = Number(metadata.size) + 1;
    const bytes = Buffer.alloc(Math.min(64 * 1024, maximumRead));
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < maximumRead) {
      const { bytesRead } = await file.read(
        bytes,
        0,
        Math.min(bytes.length, maximumRead - offset),
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      hash.update(bytes.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (
      BigInt(offset) !== metadata.size ||
      !sameVersionFile(metadata, await file.stat({ bigint: true })) ||
      !sameVersionFile(metadata, await lstat(path, { bigint: true }))
    ) {
      fail("version metadata changed during its read");
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await file.close();
  }
}

/** Bind actual GitHub observations and the Changesets output to the fixed main
 * checkout. On the pinned action's default git-cli path, prepareBranch checks
 * out changeset-release/main and resets it to github.context.sha before version.
 * GitHub Free does not provide cryptographic required-workflow-source authority;
 * these fresh observations retain the existing protected-main trust boundary. */
export async function verifyVersionWorkflow(
  root: string,
  identity: VersionRunIdentity,
): Promise<string> {
  const run = JSON.parse(
    (
      await runCommand(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          `repos/${migrationRepository}/actions/runs/${identity.runId}/attempts/${identity.attempt}`,
        ],
        root,
      )
    ).stdout,
  ) as unknown;
  const main = JSON.parse(
    (
      await runCommand(
        "gh",
        ["api", "--hostname", "github.com", `repos/${migrationRepository}/git/ref/heads/main`],
        root,
      )
    ).stdout,
  ) as unknown;
  assertVersionRunBinding(identity, run, main);
  // The frozen plan came from the accepted source before versioning. Reobserve
  // the complete candidate before either ordinary or migration baseline writes.
  await checkFrozenVersionCandidate(root);
  if (
    resolve((await git(root, ["rev-parse", "--show-toplevel"])).trim()) !== resolve(root) ||
    (await git(root, ["rev-parse", "HEAD"])).trim() !== identity.sha ||
    (await git(root, ["symbolic-ref", "--short", "HEAD"])).trim() !== "changeset-release/main"
  ) {
    fail("checkout is not the pinned Changesets version branch reset to processed main");
  }
  if ((await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])) !== "") {
    fail("untracked files are outside the generated version metadata");
  }
  if ((await git(root, ["diff", "--cached", "--name-only", "HEAD", "--"])) !== "") {
    fail("the version command must retain the action's unchanged index");
  }
  const files = parseVersionFileChanges(
    await git(root, ["diff", "--name-status", "-z", "--no-renames", "HEAD", "--"]),
  );
  const basePrereleaseState = await optionalBaseState(root, identity.sha);
  assertVersionFiles(
    files,
    typeof basePrereleaseState === "object" &&
      basePrereleaseState !== null &&
      "mode" in basePrereleaseState &&
      basePrereleaseState.mode === "exit",
  );
  const content = await Promise.all(
    files.map(async (file) => {
      if (file.status === "removed") {
        return { ...file, digest: null };
      }
      return { ...file, digest: await versionMetadataDigest(join(root, file.filename)) };
    }),
  );
  return migrationDigest(migrationBytes({ identity, files: content }));
}

export function assertVersionSnapshotUnchanged(before: string, after: string): void {
  if (!isDeepStrictEqual(before, after)) {
    fail("version metadata changed during migration preparation");
  }
}

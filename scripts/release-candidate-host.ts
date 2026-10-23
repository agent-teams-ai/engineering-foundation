import { observeCandidate } from "./release-candidate-generated-observation.ts";
import { expectedInputs, stateAt, type ReadReleaseFile } from "./release-candidate-source-facts.ts";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  CheckReport,
  ExpectedInputs,
  ObservedCandidate,
} from "../packages/release-checks/dist/index.js";
import { assertExplicitSourceGitAuthority } from "../tools/profile-root.mts";
import {
  collectChangesetsReleasePlan,
  normalizeChangesetsReleasePlan,
  type ChangesetsReleasePlan,
} from "./npm-package-bootstrap-release-plan.mts";
import { releaseBunLockViolations } from "./release-bun-lock.ts";
import {
  observeChangesetsInstallation,
  readReleaseGitFile,
  readReleaseTree,
  readReleaseWorkingFile,
  readReleaseWorkingTree,
  releaseDigest,
  releaseGit,
  releaseObject,
  releaseTreeDigest,
  requireReleaseFile,
  type ChangesetsInstallation,
  type ReleaseGitAuthority,
} from "./release-candidate-observation.ts";

const contextPathVariable = "AGENT_TEAMS_FOUNDATION_RELEASE_INPUTS_PATH";
const contextDigestVariable = "AGENT_TEAMS_FOUNDATION_RELEASE_INPUTS_DIGEST";

export interface FrozenReleaseCandidate {
  readonly schemaVersion: 1;
  readonly expected: ExpectedInputs;
  readonly officialPlan: ChangesetsReleasePlan;
  readonly custody: {
    readonly sourceRoot: string;
    readonly gitDir: string;
    readonly sourceCommit: string;
    readonly installation: ChangesetsInstallation;
  };
}
export interface ReleaseCandidateContext {
  readonly path: string;
  readonly digest: string;
  readonly environment: Readonly<Record<string, string>>;
}
export interface QualifiedReleaseCandidate {
  readonly report: CheckReport;
  readonly observed: ObservedCandidate;
  readonly expected: ExpectedInputs;
}

function fail(message: string): never {
  throw new Error(`Release candidate rejected: ${message}`);
}

export function hasReleaseVersionChanges(candidate: FrozenReleaseCandidate): boolean {
  return candidate.expected.plan.releases.some(
    (release) => release.oldVersion !== release.newVersion,
  );
}
export function shouldRunChangesetsAction(candidate: FrozenReleaseCandidate): boolean {
  // Keep the pinned action's existing no-pending-intent publication route.
  return (
    hasReleaseVersionChanges(candidate) ||
    !candidate.expected.intents.some((intent) => intent.participation === "pending")
  );
}

export async function freezeReleaseCandidate(
  cwd: string,
  options: { readonly nodeExecutable?: string; readonly cliEntrypoint?: string } = {},
): Promise<FrozenReleaseCandidate> {
  const authority = await assertExplicitSourceGitAuthority(cwd);
  const tree = await readReleaseTree(authority, authority.sourceCommit);
  if (
    releaseTreeDigest(await readReleaseWorkingTree(authority, tree)) !== releaseTreeDigest(tree) ||
    (await releaseGit(authority, [
      "diff",
      "--cached",
      "--name-only",
      authority.sourceCommit,
      "--",
    ])) !== ""
  ) {
    fail("planning requires the unchanged processed source and index.");
  }
  const config = releaseObject(
    (
      await requireReleaseFile(
        (path) => readReleaseWorkingFile(authority.sourceRoot, path),
        ".changeset/config.json",
      )
    ).bytes,
    ".changeset/config.json",
  );
  const installation = await observeChangesetsInstallation(
    config,
    options.nodeExecutable,
    options.cliEntrypoint,
  );
  const officialPlan = await collectChangesetsReleasePlan({
    cwd: authority.sourceRoot,
    cliEntrypoint: installation.entrypoint,
    nodeExecutable: installation.nodeExecutable,
  });
  const expected = await expectedInputs(authority, tree, officialPlan, installation);
  const candidate: FrozenReleaseCandidate = {
    schemaVersion: 1,
    expected,
    officialPlan,
    custody: {
      sourceRoot: authority.sourceRoot,
      gitDir: await realpath(authority.gitDir),
      sourceCommit: authority.sourceCommit,
      installation,
    },
  };
  await assertReleaseExecutionCustody(candidate);
  if (
    releaseTreeDigest(await readReleaseWorkingTree(authority, tree)) !== releaseTreeDigest(tree)
  ) {
    fail("source inputs changed during official planning.");
  }
  return candidate;
}

export async function assertReleaseExecutionCustody(
  candidate: FrozenReleaseCandidate,
): Promise<ReleaseGitAuthority> {
  const authority = await assertExplicitSourceGitAuthority(candidate.custody.sourceRoot);
  const configFile = await requireReleaseFile(
    (path) => readReleaseWorkingFile(authority.sourceRoot, path),
    ".changeset/config.json",
  );
  const config = releaseObject(configFile.bytes, ".changeset/config.json");
  const installation = await observeChangesetsInstallation(
    config,
    candidate.custody.installation.nodeExecutable,
    candidate.custody.installation.entrypoint,
  );
  if (
    authority.sourceRoot !== candidate.custody.sourceRoot ||
    (await realpath(authority.gitDir)) !== candidate.custody.gitDir ||
    authority.sourceCommit !== candidate.custody.sourceCommit ||
    !isDeepStrictEqual(installation, candidate.custody.installation) ||
    configFile.file.digest !== candidate.expected.binding.configDigest
  ) {
    fail("processed source, Git directory or Changesets execution installation changed.");
  }
  return authority;
}

export async function writeReleaseCandidateContext(
  candidate: FrozenReleaseCandidate,
): Promise<ReleaseCandidateContext> {
  const directory = await mkdtemp(join(tmpdir(), "foundation-release-checks-"));
  const path = join(directory, "inputs.json");
  const bytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const digest = releaseDigest(bytes);
  return {
    path,
    digest,
    environment: { [contextPathVariable]: path, [contextDigestVariable]: digest },
  };
}

export async function readReleaseCandidateContext(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<FrozenReleaseCandidate> {
  const path = environment[contextPathVariable];
  const digest = environment[contextDigestVariable];
  if (path === undefined || digest === undefined) {
    fail("versioning requires its frozen pre-generation context.");
  }
  const bytes = await readFile(path);
  if (releaseDigest(bytes) !== digest) {
    fail("frozen context bytes changed.");
  }
  const candidate = JSON.parse(bytes.toString("utf8")) as FrozenReleaseCandidate;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.custody?.sourceRoot === undefined ||
    candidate.expected?.binding === undefined
  ) {
    fail("frozen context is malformed.");
  }
  normalizeChangesetsReleasePlan(candidate.officialPlan);
  return candidate;
}

export async function removeReleaseCandidateContext(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<void> {
  const path = environment[contextPathVariable];
  if (path === undefined) {
    return;
  }
  const directory = dirname(path);
  if (
    basename(path) !== "inputs.json" ||
    !basename(directory).startsWith("foundation-release-checks-") ||
    (await realpath(dirname(directory))) !== (await realpath(tmpdir()))
  ) {
    fail("refusing cleanup outside the owned temporary context.");
  }
  await rm(directory, { recursive: true, force: true });
}

async function checkObserved(
  expected: ExpectedInputs,
  observed: ObservedCandidate,
): Promise<QualifiedReleaseCandidate> {
  const { checkReleaseCandidate } = await import("../packages/release-checks/dist/index.js");
  const report = checkReleaseCandidate({ schemaVersion: 1, expected, observed });
  if (report.outcome === "rejected") {
    fail(
      report.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.code}: ${diagnostic.path ?? diagnostic.packageName ?? ""} ${diagnostic.message}`,
        )
        .join("; "),
    );
  }
  return { report, expected, observed };
}

export async function checkWorkingReleaseCandidate(
  candidate: FrozenReleaseCandidate,
  options: { readonly locksRefreshed?: boolean } = {},
): Promise<QualifiedReleaseCandidate> {
  const authority = await assertReleaseExecutionCustody(candidate);
  const beforeTree = await readReleaseTree(authority, candidate.custody.sourceCommit);
  const independentlyExpected = await expectedInputs(
    authority,
    beforeTree,
    candidate.officialPlan,
    candidate.custody.installation,
  );
  if (!isDeepStrictEqual(candidate.expected, independentlyExpected)) {
    fail("frozen expected facts differ from the accepted source.");
  }
  if (
    (await releaseGit(authority, [
      "diff",
      "--cached",
      "--name-only",
      candidate.custody.sourceCommit,
      "--",
    ])) !== ""
  ) {
    fail("versioning changed the action-owned index.");
  }
  const afterTree = await readReleaseWorkingTree(authority, beforeTree);
  const readAfter = (path: string) => readReleaseWorkingFile(authority.sourceRoot, path);
  const observed = await observeCandidate({
    authority,
    sourceIdentity: authority.sourceCommit,
    expected: independentlyExpected,
    beforeTree,
    afterTree,
    readAfter,
    candidateIdentity: `working:${releaseTreeDigest(afterTree)}`,
    installation: candidate.custody.installation,
  });
  const qualified = await checkObserved(independentlyExpected, observed);
  await assertHostReleaseContent(
    qualified,
    (path) => readReleaseGitFile(authority, beforeTree, path),
    readAfter,
    options.locksRefreshed === true,
  );
  await assertReleaseExecutionCustody(candidate);
  return qualified;
}

export async function checkFrozenVersionCandidate(
  root: string,
): Promise<QualifiedReleaseCandidate> {
  const candidate = await readReleaseCandidateContext();
  if ((await realpath(root)) !== candidate.custody.sourceRoot) {
    fail("the baseline writer belongs to a different source root.");
  }
  return checkWorkingReleaseCandidate(candidate);
}

async function assertHostReleaseContent(
  qualified: QualifiedReleaseCandidate,
  readBefore: ReadReleaseFile,
  readAfter: ReadReleaseFile,
  locksRefreshed: boolean,
): Promise<void> {
  if (qualified.report.packageChanges.length === 0) {
    return;
  }
  const { releasePullRequestContentViolations, releasePullRequestFileViolations } =
    await import("./check-release-pr-files.mjs");
  const basePrereleaseState = await stateAt(readBefore);
  const headPrereleaseState = await stateAt(readAfter);
  const initialVersionAdditions = qualified.report.packageChanges
    .filter((change) => change.oldVersion === "0.0.0")
    .map((change) => change.packageName);
  const privateDocs = qualified.expected.packages.find(
    (pkg) => pkg.name === "@agent-teams/docs-protocol",
  );
  const docsBootstrapInitialVersionAddition =
    privateDocs?.classification === "private" &&
    privateDocs.versioning === "ignored" &&
    privateDocs.before.semantic["version"] === "0.0.0" &&
    !Object.hasOwn(privateDocs.before.semantic, "publishConfig");
  const violations: string[] = [];
  for (const change of qualified.report.packageChanges) {
    const pkg = qualified.expected.packages.find((entry) => entry.name === change.packageName)!;
    if (pkg.classification !== "public") {
      continue;
    }
    const manifest = qualified.observed.manifests.find(
      (entry) => entry.manifestPath === pkg.manifestPath,
    )!;
    const changelog = `${pkg.root}/CHANGELOG.md`;
    violations.push(
      ...releasePullRequestContentViolations({
        baseManifest: manifest.before?.semantic,
        headManifest: manifest.after?.semantic,
        baseChangelog: (await readBefore(changelog))?.bytes.toString("utf8"),
        headChangelog: (await readAfter(changelog))?.bytes.toString("utf8"),
        basePrereleaseState,
        headPrereleaseState,
        initialVersionAdditions,
        docsBootstrapInitialVersionAddition,
      }).map((message: string) => `${pkg.name}: ${message}`),
    );
  }
  const files = qualified.observed.diff
    .filter((change) => change.path !== "bun.lock")
    .map((change) => ({
      filename: change.path,
      status: change.kind === "deleted" ? "removed" : change.kind,
    }));
  violations.push(
    ...releasePullRequestFileViolations(files, {
      prereleaseExit: basePrereleaseState?.["mode"] === "exit",
    }),
  );
  if (locksRefreshed) {
    violations.push(
      ...releaseBunLockViolations(
        (await readBefore("bun.lock"))?.bytes,
        (await readAfter("bun.lock"))?.bytes,
        qualified.report.packageChanges.map((change) => ({
          root: qualified.expected.packages.find((pkg) => pkg.name === change.packageName)!.root,
          name: change.packageName,
          baseVersion: change.oldVersion!,
          headVersion: change.newVersion!,
        })),
      ).map((message) => `bun.lock: ${message}`),
    );
  }
  if (violations.length !== 0) {
    fail(violations.join("; "));
  }
}

/** Rebuild expected facts in an owned accepted-base checkout. Candidate versions
 * never participate in planning; absolute paths never become portable bindings. */
export async function checkReleaseCandidateRevisions(
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<QualifiedReleaseCandidate> {
  const authority = await assertExplicitSourceGitAuthority(cwd);
  const beforeTree = await readReleaseTree(authority, baseSha);
  const afterTree = await readReleaseTree(authority, headSha);
  const temporary = await mkdtemp(join(tmpdir(), "foundation-release-base-"));
  const baseRoot = join(temporary, "source");
  let worktreeCreated = false;
  try {
    await releaseGit(authority, ["worktree", "add", "--detach", baseRoot, baseSha]);
    worktreeCreated = true;
    const candidate = await freezeReleaseCandidate(baseRoot);
    const readAfter = (path: string) => readReleaseGitFile(authority, afterTree, path);
    const sourceIdentity = (
      await releaseGit(authority, ["rev-parse", "--verify", `${baseSha}^{commit}`])
    ).trim();
    const observed = await observeCandidate({
      authority,
      sourceIdentity,
      expected: candidate.expected,
      beforeTree,
      afterTree,
      readAfter,
      candidateIdentity: headSha,
      installation: candidate.custody.installation,
    });
    const qualified = await checkObserved(candidate.expected, observed);
    await assertHostReleaseContent(
      qualified,
      (path) => readReleaseGitFile(authority, beforeTree, path),
      readAfter,
      true,
    );
    await assertReleaseExecutionCustody(candidate);
    const currentAuthority = await assertExplicitSourceGitAuthority(cwd);
    if (
      currentAuthority.sourceRoot !== authority.sourceRoot ||
      (await realpath(currentAuthority.gitDir)) !== (await realpath(authority.gitDir)) ||
      currentAuthority.sourceCommit !== authority.sourceCommit
    ) {
      fail("PR qualification source custody changed.");
    }
    return qualified;
  } finally {
    if (worktreeCreated) {
      await releaseGit(authority, ["worktree", "remove", "--force", baseRoot]);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

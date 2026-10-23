import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import type {
  CheckReport,
  ExpectedInputs,
  FileChange,
  JsonRecord,
  ManifestSnapshot,
  ObservedCandidate,
  ObservedConsumption,
  PermittedChange,
  ReleaseIntent,
  ReleaseType,
  WorkspacePackage,
} from "../packages/release-checks/dist/index.js";
import { assertExplicitSourceGitAuthority } from "../tools/profile-root.mts";
import {
  collectChangesetsReleasePlan,
  normalizeChangesetsReleasePlan,
  type ChangesetsReleasePlan,
} from "./npm-package-bootstrap-release-plan.mts";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import { releaseBunLockViolations } from "./release-bun-lock.ts";
import {
  observeChangesetsInstallation,
  readReleaseGitFile,
  readReleaseTree,
  readReleaseWorkingFile,
  readReleaseWorkingTree,
  releaseDigest,
  releaseGit,
  releaseJsonDigest,
  releaseObject,
  releaseTreeDigest,
  requireReleaseFile,
  type ChangesetsInstallation,
  type ReleaseFileBytes,
  type ReleaseGitAuthority,
  type ReleaseTree,
} from "./release-candidate-observation.ts";

const contextPathVariable = "AGENT_TEAMS_FOUNDATION_RELEASE_INPUTS_PATH";
const contextDigestVariable = "AGENT_TEAMS_FOUNDATION_RELEASE_INPUTS_DIGEST";
const ordinary = { type: "file", mode: "100644" } as const;
// Changesets 2.31.1 reads direct non-hidden .md files and ignores README case-insensitively.
const intentPattern = /^\.changeset\/[^./][^/]*\.md$/u;
const baselinePattern =
  /^architecture\/(?:public-api\/[^/]+\.json|contracts\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:json|ya?ml))$/u;
type ReadReleaseFile = (path: string) => Promise<ReleaseFileBytes | null>;

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
function snapshot(file: ReleaseFileBytes | null, path: string): ManifestSnapshot | null {
  return file === null ? null : { file: file.file, semantic: releaseObject(file.bytes, path) };
}
async function stateAt(read: ReadReleaseFile): Promise<JsonRecord | undefined> {
  const file = await read(".changeset/pre.json");
  return file === null ? undefined : releaseObject(file.bytes, ".changeset/pre.json");
}

function workspacePaths(tree: ReleaseTree, root: JsonRecord): readonly string[] {
  const workspace = root["workspaces"];
  const patterns = Array.isArray(workspace)
    ? workspace
    : workspace !== null && typeof workspace === "object" && !Array.isArray(workspace)
      ? (workspace as JsonRecord)["packages"]
      : undefined;
  if (
    !Array.isArray(patterns) ||
    patterns.some((pattern) => typeof pattern !== "string" || !/^[^/*]+\/\*$/u.test(pattern))
  ) {
    fail("the Foundation Host requires explicit one-level workspace patterns.");
  }
  const parents = patterns.map((pattern) => (pattern as string).slice(0, -2));
  return [
    "package.json",
    ...[...tree.keys()]
      .filter((path) => {
        const parts = path.split("/");
        return parts.length === 3 && parts[2] === "package.json" && parents.includes(parts[0]!);
      })
      .toSorted(),
  ];
}

async function inventory(
  tree: ReleaseTree,
  read: ReadReleaseFile,
  config: JsonRecord,
): Promise<readonly WorkspacePackage[]> {
  const root = releaseObject(
    (await requireReleaseFile(read, "package.json")).bytes,
    "package.json",
  );
  const ignored = config["ignore"];
  if (!Array.isArray(ignored) || ignored.some((value) => typeof value !== "string")) {
    fail("Changesets ignore must be an explicit package inventory.");
  }
  const privateOptions = config["privatePackages"];
  if (
    privateOptions === null ||
    typeof privateOptions !== "object" ||
    Array.isArray(privateOptions) ||
    typeof (privateOptions as JsonRecord)["version"] !== "boolean"
  ) {
    fail("Changesets private package versioning must be explicit.");
  }
  const packages: WorkspacePackage[] = [];
  for (const path of workspacePaths(tree, root)) {
    const before = snapshot(await requireReleaseFile(read, path), path)!;
    const name = before.semantic["name"];
    if (typeof name !== "string" || name === "") {
      fail(`${path} has no package identity.`);
    }
    const classification = before.semantic["private"] === true ? "private" : "public";
    const versioning = ignored.includes(name)
      ? "ignored"
      : path === "package.json" ||
          typeof before.semantic["version"] !== "string" ||
          (classification === "private" && !(privateOptions as JsonRecord)["version"])
        ? "unversioned"
        : "versioned";
    const catalogEntry = PUBLISHABLE_PACKAGES.find(
      (entry: { readonly name: string }) => entry.name === name,
    ) as { readonly manifestPath: string } | undefined;
    if (
      classification === "public" &&
      (catalogEntry === undefined || catalogEntry.manifestPath !== path)
    ) {
      fail(`${path} does not match the publishable catalog.`);
    }
    packages.push({
      name,
      root: path === "package.json" ? "." : path.slice(0, -"/package.json".length),
      manifestPath: path,
      classification,
      versioning,
      before,
    });
  }
  return packages;
}

/** Read raw source intents independently of the engine's selected plan. */
async function sourceIntents(
  tree: ReleaseTree,
  read: ReadReleaseFile,
  pre: JsonRecord | undefined,
): Promise<readonly ReleaseIntent[]> {
  const applied =
    pre?.["mode"] === "pre" && Array.isArray(pre["changesets"]) ? pre["changesets"] : [];
  const intents: ReleaseIntent[] = [];
  for (const path of [...tree.keys()]
    .filter((entry) => intentPattern.test(entry) && !/^README\.md$/iu.test(basename(entry)))
    .toSorted()) {
    const file = await requireReleaseFile(read, path);
    const source = file.bytes.toString("utf8").replaceAll("\r\n", "\n");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
    const empty = /^---\n---\n[\s\S]*$/u.test(source);
    if (!empty && match === null) {
      fail(`${path} has unsupported Changesets frontmatter.`);
    }
    const value: unknown = empty ? {} : parseYaml(match![1]!);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`${path} must request package release types.`);
    }
    const requests = Object.entries(value).map(([packageName, type]) => {
      if (!["major", "minor", "patch"].includes(String(type))) {
        fail(`${path} has an unsupported release type.`);
      }
      return { packageName, type: type as ReleaseType };
    });
    const id = basename(path).replace(".md", "");
    intents.push({
      id,
      path,
      digest: file.file.digest,
      participation: applied.includes(id) ? "retained" : "pending",
      requests,
    });
  }
  return intents;
}

function intentConsumptions(
  plan: ChangesetsReleasePlan,
  packages: readonly WorkspacePackage[],
  intents: readonly ReleaseIntent[],
  pre: JsonRecord | undefined,
): ExpectedInputs["plan"]["consumptions"] {
  if (!plan.releases.some((entry) => entry.oldVersion !== entry.newVersion)) {
    return [];
  }
  const selected = new Set(plan.changesets.map((intent) => intent.id));
  return intents
    .filter(
      (intent) =>
        selected.has(intent.id) &&
        intent.participation === "pending" &&
        intent.requests.every(
          (request) =>
            packages.find((pkg) => pkg.name === request.packageName)?.versioning === "versioned",
        ),
    )
    .map((intent) => ({
      intentId: intent.id,
      effect:
        pre?.["mode"] === "pre"
          ? { kind: "record" as const, evidencePath: ".changeset/pre.json" }
          : { kind: "remove" as const },
    }));
}

async function permittedChanges(
  tree: ReleaseTree,
  read: ReadReleaseFile,
  packages: readonly WorkspacePackage[],
  intents: readonly ReleaseIntent[],
  pre: JsonRecord | undefined,
): Promise<readonly PermittedChange[]> {
  const allowed = new Map<string, PermittedChange>();
  const admit = (
    path: string,
    classification: string,
    contentAuthority: string,
    deletion = false,
  ): void => {
    const before = tree.get(path)?.shape ?? null;
    allowed.set(path, {
      path,
      classification,
      contentAuthority,
      kind: deletion ? "deleted" : before === null ? "added" : "modified",
      before,
      after: deletion ? null : ordinary,
    });
  };
  for (const pkg of packages) {
    admit(pkg.manifestPath, "manifest", "release-checks:version-only");
    if (pkg.classification === "public") {
      admit(`${pkg.root}/CHANGELOG.md`, "changelog", "foundation:release-content");
    }
  }
  for (const intent of intents) {
    admit(intent.path, "intent", "release-checks:consumption", true);
  }
  if (pre !== undefined) {
    admit(
      ".changeset/pre.json",
      "prerelease",
      "foundation:prerelease-content",
      pre["mode"] === "exit",
    );
  }
  if (tree.has("bun.lock")) {
    admit("bun.lock", "lock", "foundation:release-bun-lock");
  }
  // Baseline destinations are accepted policy fields, never paths discovered in generated output.
  const destinations = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (
          key === "releasedBaselinePath" &&
          typeof entry === "string" &&
          baselinePattern.test(entry)
        ) {
          destinations.add(entry);
        } else {
          visit(entry);
        }
      }
    }
  };
  for (const path of [...tree.keys()].filter((entry) =>
    /^architecture\/foundation\/[^/]+\.(?:json|ya?ml)$/u.test(entry),
  )) {
    const file = await requireReleaseFile(read, path);
    visit(parseYaml(file.bytes.toString("utf8")));
  }
  for (const path of [...destinations].toSorted()) {
    admit(path, "baseline", "foundation:released-baseline");
  }
  return [...allowed.values()].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function inventoryDigest(packages: readonly WorkspacePackage[]): string {
  return releaseJsonDigest(packages.map(({ before: _before, ...identity }) => identity));
}

async function expectedInputs(
  authority: ReleaseGitAuthority,
  tree: ReleaseTree,
  plan: ChangesetsReleasePlan,
  installation: ChangesetsInstallation,
): Promise<ExpectedInputs> {
  const read = (path: string) => readReleaseGitFile(authority, tree, path);
  const configFile = await requireReleaseFile(read, ".changeset/config.json");
  const config = releaseObject(configFile.bytes, ".changeset/config.json");
  const pre = await stateAt(read);
  const packages = await inventory(tree, read, config);
  const intents = await sourceIntents(tree, read, pre);
  const permitted = await permittedChanges(tree, read, packages, intents, pre);
  const releases = plan.releases.map((release) => {
    const pkg = packages.find((candidate) => candidate.name === release.name);
    if (pkg === undefined) {
      fail(`official plan references unknown package ${release.name}.`);
    }
    return {
      packageName: release.name,
      manifestPath: pkg.manifestPath,
      type: release.type,
      oldVersion: release.oldVersion ?? null,
      newVersion: release.newVersion ?? null,
      intentIds: release.changesets,
    };
  });
  const normalizedPlan = {
    releases,
    consumptions: intentConsumptions(plan, packages, intents, pre),
  };
  return {
    packages,
    intents,
    plan: normalizedPlan,
    permittedChanges: permitted,
    binding: {
      source: {
        repository: "agent-teams-ai/engineering-foundation",
        identity: authority.sourceCommit,
        digest: releaseTreeDigest(tree),
      },
      engine: {
        name: installation.name,
        version: installation.version,
        digest: installation.digest,
      },
      configDigest: configFile.file.digest,
      inventoryDigest: inventoryDigest(packages),
      policyDigest: releaseJsonDigest(permitted),
      intentsDigest: releaseJsonDigest(intents),
      planDigest: releaseJsonDigest(normalizedPlan),
    },
  };
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

function observedConsumptions(
  beforePre: JsonRecord | undefined,
  afterPre: JsonRecord | undefined,
  intents: readonly ReleaseIntent[],
  afterTree: ReleaseTree,
): readonly ObservedConsumption[] {
  const consumptions: ObservedConsumption[] = [];
  const recordedBefore = new Set(
    Array.isArray(beforePre?.["changesets"]) ? beforePre["changesets"] : [],
  );
  const recordedAfter = new Set(
    Array.isArray(afterPre?.["changesets"]) ? afterPre["changesets"] : [],
  );
  for (const id of recordedAfter) {
    if (!recordedBefore.has(id) && !intents.some((intent) => intent.id === id)) {
      fail("prerelease metadata recorded an unknown source intent.");
    }
  }
  for (const intent of intents) {
    if (!afterTree.has(intent.path)) {
      consumptions.push({ intentId: intent.id, digest: intent.digest, effect: { kind: "remove" } });
    } else if (recordedAfter.has(intent.id) && !recordedBefore.has(intent.id)) {
      consumptions.push({
        intentId: intent.id,
        digest: intent.digest,
        effect: { kind: "record", evidencePath: ".changeset/pre.json" },
      });
    }
  }
  return consumptions;
}

async function observeCandidate({
  authority,
  sourceIdentity,
  expected,
  beforeTree,
  afterTree,
  readAfter,
  candidateIdentity,
  installation,
}: {
  readonly authority: ReleaseGitAuthority;
  readonly sourceIdentity: string;
  readonly expected: ExpectedInputs;
  readonly beforeTree: ReleaseTree;
  readonly afterTree: ReleaseTree;
  readonly readAfter: ReadReleaseFile;
  readonly candidateIdentity: string;
  readonly installation: ChangesetsInstallation;
}): Promise<ObservedCandidate> {
  const readBefore = (path: string) => readReleaseGitFile(authority, beforeTree, path);
  const configFile = await requireReleaseFile(readAfter, ".changeset/config.json");
  const config = releaseObject(configFile.bytes, ".changeset/config.json");
  const afterPackages = await inventory(afterTree, readAfter, config);
  const beforePre = await stateAt(readBefore);
  const afterPre = await stateAt(readAfter);
  const rawIntents = await sourceIntents(beforeTree, readBefore, beforePre);
  const manifests = [];
  for (const path of [
    ...new Set([
      ...expected.packages.map((pkg) => pkg.manifestPath),
      ...afterPackages.map((pkg) => pkg.manifestPath),
    ]),
  ].toSorted()) {
    manifests.push({
      manifestPath: path,
      before: snapshot(await readBefore(path), path),
      after: snapshot(await readAfter(path), path),
    });
  }
  const diff: FileChange[] = [];
  for (const path of [...new Set([...beforeTree.keys(), ...afterTree.keys()])].toSorted()) {
    if (isDeepStrictEqual(beforeTree.get(path), afterTree.get(path))) {
      continue;
    }
    const before = await readBefore(path);
    const after = await readAfter(path);
    const classification =
      expected.permittedChanges.find((change) => change.path === path)?.classification ??
      "unclassified";
    diff.push({
      path,
      classification,
      kind: before === null ? "added" : after === null ? "deleted" : "modified",
      before: before?.file ?? null,
      after: after?.file ?? null,
    });
  }
  const consumptions = observedConsumptions(beforePre, afterPre, rawIntents, afterTree);
  return {
    candidateIdentity,
    manifests,
    diff,
    consumptions,
    binding: {
      source: {
        repository: "agent-teams-ai/engineering-foundation",
        identity: sourceIdentity,
        digest: releaseTreeDigest(beforeTree),
      },
      engine: {
        name: installation.name,
        version: installation.version,
        digest: installation.digest,
      },
      configDigest: configFile.file.digest,
      inventoryDigest: inventoryDigest(afterPackages),
      policyDigest: releaseJsonDigest(
        await permittedChanges(beforeTree, readBefore, expected.packages, rawIntents, beforePre),
      ),
      intentsDigest: releaseJsonDigest(rawIntents),
      planDigest: releaseJsonDigest(expected.plan),
    },
  };
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

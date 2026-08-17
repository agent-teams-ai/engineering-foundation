/* oxlint-disable max-lines -- V1 keeps the security-sensitive repository observation boundary cohesive. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { execFile } from "node:child_process";
import { parseDocument } from "yaml";

import { parseJsonRecord } from "../../adapters/adoption-input.js";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationFileObservation,
  ConsumerIntegrationSnapshot
} from "../domain/model.js";
import { assertConsumerIntegrationProfileSchema } from "./consumer-integration-schema-validator.js";
import { targetsManagedPackage, validPnpmPeerContext } from "./pnpm-lockfile-policy-v1.js";
import {
  computePnpmRuntimeClosureDigestV1,
  PnpmRuntimeClosureError
} from "./pnpm-runtime-closure-v1.js";
import {
  scanConsumerRepositoryTopology,
  type ConsumerRepositoryTopology
} from "./bounded-repository-topology.js";

const MAXIMUM_PROFILE_BYTES = 256 * 1024;
const MAXIMUM_MANIFEST_BYTES = 1024 * 1024;
const MAXIMUM_MANAGED_ASSET_BYTES = 8 * 1024 * 1024;
const MAXIMUM_LOCKFILE_BYTES = 32 * 1024 * 1024;
const INTEGRATION_PROFILE_PATH = "architecture/foundation/docs-consumer-integration.json";

function executeGit(root: string, args: readonly string[], maximumBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: maximumBytes
    }, (error, stdout) => {
      if (error === null) {resolve(stdout);}
      else {reject(error);}
    });
  });
}

export class ConsumerIntegrationNodeError extends Error {
  readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConsumerIntegrationNodeError";
    this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function contained(root: string, repositoryPath: string): string {
  const absolute = resolvePath(root, repositoryPath);
  const relation = relative(root, absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PATH_ESCAPE",
      `Consumer integration path escapes the repository root: ${repositoryPath}.`
    );
  }
  return absolute;
}

async function canonicalRoot(consumerRoot: string): Promise<string> {
  const requested = resolvePath(consumerRoot);
  let metadata;
  try {
    metadata = await lstat(requested);
  } catch (error) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_ROOT_INVALID",
      "Consumer root is unavailable or is not a real directory.",
      { cause: error }
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_ROOT_INVALID",
      "Consumer root must be one real directory."
    );
  }
  return realpath(requested);
}

function assertSingleIntegrationTopology(topology: ConsumerRepositoryTopology): void {
  if (topology.lockfiles.length !== 1 || topology.lockfiles[0] !== "pnpm-lock.yaml") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_NESTED_LOCKFILE_UNSUPPORTED",
      "V1 requires exactly one root pnpm-lock.yaml and no nested lockfiles."
    );
  }
  if (topology.integrationProfiles.length !== 1 ||
    topology.integrationProfiles[0] !== INTEGRATION_PROFILE_PATH) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_MULTIPLE_INTEGRATION_UNITS",
      `V1 requires exactly one integration profile at ${INTEGRATION_PROFILE_PATH}.`
    );
  }
  if (topology.pnpmfiles.length > 0) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PNPMFILE_UNSUPPORTED",
      "V1 does not permit .pnpmfile.cjs in the integration repository."
    );
  }
}

async function assertGitRepositoryRoot(root: string): Promise<void> {
  let gitRoot: string;
  try {
    gitRoot = await realpath((await executeGit(
      root,
      ["rev-parse", "--show-toplevel"],
      64 * 1024
    )).trim());
  } catch (error) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_GIT_ROOT_INVALID",
      "Consumer root must be the exact top-level directory of one Git repository.",
      { cause: error }
    );
  }
  if (gitRoot !== root) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_GIT_ROOT_INVALID",
      "Consumer root must equal the Git repository top-level directory."
    );
  }
}

function assertNestedAgentsAuthority(
  topology: ConsumerRepositoryTopology,
  governedRoots: readonly string[] | undefined
): void {
  const nested = topology.agents.filter((path) => path !== "AGENTS.md");
  const conflicting = governedRoots === undefined
    ? nested
    : nested.filter((path) => {
        const authorityRoot = dirname(path);
        return governedRoots.some((docsRoot) =>
          authorityRoot === docsRoot ||
          authorityRoot.startsWith(`${docsRoot}/`) ||
          docsRoot.startsWith(`${authorityRoot}/`)
        );
      });
  if (conflicting.length > 0) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_NESTED_AGENTS_UNSUPPORTED",
      `Nested AGENTS.md overlaps governed documentation authority: ${conflicting.join(", ")}.`
    );
  }
}

async function readStableFile(
  root: string,
  repositoryPath: string,
  maximumBytes: number,
  required: boolean
): Promise<ConsumerIntegrationFileObservation> {
  const path = contained(root, repositoryPath);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
  } catch (error) {
    if (!required && errorCode(error) === "ENOENT") {
      return { state: "absent" };
    }
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_INPUT_MISSING",
      `Required consumer integration input is unavailable: ${repositoryPath}.`,
      { cause: error }
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n || before.size > BigInt(maximumBytes)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_INPUT_INVALID",
        `Consumer integration input must be one bounded, non-hardlinked regular file: ${repositoryPath}.`
      );
    }
    const bytes = await handle.readFile();
    const [after, pathState, canonical] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path)
    ]);
    if (pathState.isSymbolicLink() || canonical !== path ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.birthtimeNs !== after.birthtimeNs || before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs || before.size !== after.size ||
      pathState.dev !== after.dev || pathState.ino !== after.ino ||
      bytes.byteLength !== Number(after.size)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_INPUT_UNSTABLE",
        `Consumer integration input changed during observation: ${repositoryPath}.`
      );
    }
    return { state: "file", bytes, mode: Number(after.mode) & 0o777 };
  } finally {
    await handle.close();
  }
}

function rejectPrototypeKeys(value: unknown, path = "integration profile"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectPrototypeKeys(entry, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {return;}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_PROFILE_INVALID",
        `${path}.${key} is forbidden.`
      );
    }
    rejectPrototypeKeys(entry, `${path}.${key}`);
  }
}

function assertGitHubRuntimeIdentity(desired: ConsumerIntegrationDesiredStateV1): void {
  const runtimeId = process.env["GITHUB_REPOSITORY_ID"];
  const runtimeName = process.env["GITHUB_REPOSITORY"];
  if (runtimeId !== undefined && runtimeId !== desired.repository.id) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_REPOSITORY_ID_MISMATCH",
      "GitHub runtime repository ID does not match the committed integration profile."
    );
  }
  if (runtimeName !== undefined && runtimeName.toLowerCase() !==
    desired.repository.nameWithOwner.toLowerCase()) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_REPOSITORY_NAME_MISMATCH",
      "GitHub runtime repository name does not match the committed integration profile."
    );
  }
}

async function assertQualifiedPnpmRoot(root: string): Promise<void> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || (minor ?? 0) < 18) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UNSUPPORTED_NODE",
      "V1 check and plan require Node >=24.18.0 <25."
    );
  }
  const manifestObservation = await readStableFile(
    root,
    "package.json",
    MAXIMUM_MANIFEST_BYTES,
    true
  );
  if (manifestObservation.state !== "file") {throw new Error("unreachable");}
  let manifest: Record<string, unknown>;
  try {
    manifest = parseJsonRecord(Buffer.from(manifestObservation.bytes).toString("utf8"));
  } catch (error) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_MANIFEST_INVALID",
      error instanceof Error ? error.message : "package.json is invalid.",
      { cause: error }
    );
  }
  const packageManager = manifest["packageManager"];
  const match = typeof packageManager === "string"
    ? /^pnpm@(11)\.([0-9]+)\.([0-9]+)(?:\+sha512\.[A-Za-z0-9+/=]+)?$/u.exec(packageManager)
    : null;
  if (match === null || Number(match[2]) < 17) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UNSUPPORTED_PACKAGE_MANAGER",
      "V1 requires one exact root packageManager declaration within >=11.17.0 <12."
    );
  }
  const nodeVersion = await readStableFile(root, ".node-version", 128, true);
  if (nodeVersion.state !== "file" ||
    !/^24\.(?:1[89]|[2-9][0-9])\.[0-9]+\n?$/u.test(Buffer.from(nodeVersion.bytes).toString("utf8"))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_NODE_VERSION_GATE_INVALID",
      ".node-version must pin one exact Node version within >=24.18.0 <25."
    );
  }
  await readStableFile(root, "pnpm-lock.yaml", MAXIMUM_LOCKFILE_BYTES, true);
  for (const path of ["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
    if ((await readStableFile(root, path, 1024, false)).state !== "absent") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UNSUPPORTED_PACKAGE_MANAGER",
        `Multiple or unsupported package-manager evidence is present: ${path}.`
      );
    }
  }
}

function sameObservation(
  left: ConsumerIntegrationFileObservation,
  right: ConsumerIntegrationFileObservation
): boolean {
  return left.state === right.state && (left.state === "absent" ||
    (right.state === "file" && left.mode === right.mode &&
      Buffer.from(left.bytes).equals(Buffer.from(right.bytes))));
}

async function assertSnapshotStillStable(input: {
  readonly root: string;
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly snapshot: ConsumerIntegrationSnapshot;
}): Promise<void> {
  const paths = [
    ["integrationProfile", INTEGRATION_PROFILE_PATH, MAXIMUM_PROFILE_BYTES, true],
    ["lockfile", "pnpm-lock.yaml", MAXIMUM_LOCKFILE_BYTES, true],
    ["packageManifest", "package.json", MAXIMUM_MANIFEST_BYTES, true],
    ["agents", "AGENTS.md", MAXIMUM_MANAGED_ASSET_BYTES, false],
    ["skill", input.desired.skillPath, MAXIMUM_MANAGED_ASSET_BYTES, false],
    ["callerWorkflow", input.desired.callerWorkflowPath, MAXIMUM_MANAGED_ASSET_BYTES, false],
    ["managedState", input.desired.managedStatePath, MAXIMUM_MANAGED_ASSET_BYTES, false]
  ] as const;
  const reread = await Promise.all(paths.map(([, path, maximum, required]) =>
    readStableFile(input.root, path, maximum, required)
  ));
  const unstable = paths.find(([key], index) =>
    !sameObservation(input.snapshot[key], reread[index]!)
  );
  if (unstable !== undefined) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_SNAPSHOT_UNSTABLE",
      `Consumer integration input changed while the repository snapshot was assembled: ${unstable[1]}.`
    );
  }
}

function yamlRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INVALID",
      `${subject} must be one mapping.`
    );
  }
  return value as Record<string, unknown>;
}

function assertRegistryPackageEntry(options: {
  readonly integrity: string;
  readonly packageEntry: Record<string, unknown>;
  readonly packageName: string;
}): void {
  const resolution = yamlRecord(
    options.packageEntry["resolution"],
    `pnpm-lock.yaml#packages.${options.packageName}.resolution`
  );
  if (resolution["integrity"] !== options.integrity) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INTEGRITY_MISMATCH",
      `${options.packageName} registry integrity does not match the selected cohort.`
    );
  }
  const tarball = resolution["tarball"];
  if (typeof tarball === "string" && !tarball.startsWith("https://registry.npmjs.org/")) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_SOURCE_INVALID",
      `${options.packageName} must resolve from registry.npmjs.org.`
    );
  }
}

function assertRootOwnsCohortPins(
  importers: Record<string, unknown>,
  packageNames: readonly string[]
): void {
  for (const [importerPath, importerValue] of Object.entries(importers)) {
    if (importerPath === ".") {continue;}
    const nestedImporter = yamlRecord(importerValue, `pnpm-lock.yaml#importers.${importerPath}`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const declarations = nestedImporter[field];
      if (declarations === undefined) {continue;}
      const record = yamlRecord(declarations, `pnpm-lock.yaml#importers.${importerPath}.${field}`);
      if (packageNames.some((packageName) => record[packageName] !== undefined)) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_NESTED_IMPORTER_PIN_FORBIDDEN",
          `Only the root importer may own Docs Protocol cohort pins; found one in ${importerPath}.`
        );
      }
    }
  }
}

function assertRegistryBoundRuntimeClosure(
  lockfile: Record<string, unknown>,
  desired: ConsumerIntegrationDesiredStateV1
): void {
  try {
    // The Cohort digest qualifies the isolated release graph. A consumer may select
    // compatible transitives or peer contexts, but every reachable edge stays registry/SRI bound.
    computePnpmRuntimeClosureDigestV1(lockfile, desired.cohort);
  } catch (error) {
    if (error instanceof PnpmRuntimeClosureError) {
      throw new ConsumerIntegrationNodeError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

async function assertQualifiedLockfile(
  root: string,
  desired: ConsumerIntegrationDesiredStateV1
): Promise<ConsumerIntegrationFileObservation> {
  const observation = await readStableFile(
    root,
    "pnpm-lock.yaml",
    MAXIMUM_LOCKFILE_BYTES,
    true
  );
  if (observation.state !== "file") {throw new Error("unreachable");}
  const document = parseDocument(
    Buffer.from(observation.bytes).toString("utf8"),
    { uniqueKeys: true }
  );
  if (document.errors.length > 0) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INVALID",
      "pnpm-lock.yaml must be duplicate-free YAML."
    );
  }
  const lockfile = yamlRecord(document.toJS({ maxAliasCount: 0 }), "pnpm-lock.yaml");
  if (String(lockfile["lockfileVersion"]) !== "9.0") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INVALID",
      "V1 requires pnpm lockfileVersion 9.0."
    );
  }
  if (targetsManagedPackage(lockfile["overrides"]) ||
    targetsManagedPackage(lockfile["patchedDependencies"])) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_OVERRIDE",
      "Docs Protocol cohort packages must not use lockfile overrides or patches."
    );
  }
  const importers = yamlRecord(lockfile["importers"], "pnpm-lock.yaml#importers");
  if (importers["."] === undefined) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UNSUPPORTED_WORKSPACE",
      "V1 requires one root pnpm importer in the repository lockfile."
    );
  }
  const importer = yamlRecord(
    importers["."],
    "pnpm-lock.yaml#importers."
  );
  const devDependencies = yamlRecord(
    importer["devDependencies"],
    "pnpm-lock.yaml#importers...devDependencies"
  );
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const declarations = importer[field];
    if (declarations === undefined) {continue;}
    const record = yamlRecord(declarations, `pnpm-lock.yaml#importers...${field}`);
    if (["@agent-teams/docs-protocol", "@agent-teams/engineering-foundation"]
      .some((packageName) => record[packageName] !== undefined)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_NON_DEV_DEPENDENCY",
        "Docs Protocol cohort packages may be declared only in root devDependencies."
      );
    }
  }
  const packages = yamlRecord(lockfile["packages"], "pnpm-lock.yaml#packages");
  const snapshots = yamlRecord(lockfile["snapshots"], "pnpm-lock.yaml#snapshots");
  const targets = [
    ["@agent-teams/docs-protocol", desired.cohort.packages.docsProtocol],
    ["@agent-teams/engineering-foundation", desired.cohort.packages.engineeringFoundation]
  ] as const;
  assertRootOwnsCohortPins(importers, targets.map(([packageName]) => packageName));
  for (const [packageName, target] of targets) {
    const importerEntry = yamlRecord(
      devDependencies[packageName],
      `pnpm-lock.yaml#importers...${packageName}`
    );
    const selectedVersion = importerEntry["version"];
    if (importerEntry["specifier"] !== target.version ||
      !validPnpmPeerContext(selectedVersion, target.version)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_LOCKFILE_COHORT_MISMATCH",
        `${packageName} importer evidence must select exact cohort version ${target.version}.`
      );
    }
    const packageEntry = yamlRecord(
      packages[`${packageName}@${target.version}`],
      `pnpm-lock.yaml#packages.${packageName}`
    );
    assertRegistryPackageEntry({
      integrity: target.integrity,
      packageEntry,
      packageName
    });
    const snapshotKey = `${packageName}@${selectedVersion}`;
    if (snapshots[snapshotKey] === undefined) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_LOCKFILE_SNAPSHOT_MISSING",
        `${packageName} must have the exact selected pnpm snapshot.`
      );
    }
  }
  for (const [packageName, target] of targets) {
    const prefix = `${packageName}@`;
    const keys = Object.keys(packages).filter((key) => key.startsWith(prefix));
    if (keys.length !== 1 || keys[0] !== `${prefix}${target.version}`) {
      throw new ConsumerIntegrationNodeError(
        packageName.endsWith("engineering-foundation")
          ? "DOCS_CONSUMER_DUPLICATE_FOUNDATION_RESOLUTION"
          : "DOCS_CONSUMER_DUPLICATE_DOCS_PROTOCOL_RESOLUTION",
        `pnpm-lock.yaml must contain exactly one physical cohort ${packageName} resolution.`
      );
    }
  }
  const docsSelection = yamlRecord(
    devDependencies["@agent-teams/docs-protocol"],
    "pnpm-lock.yaml#importers...docs-protocol"
  )["version"];
  const docsSnapshot = yamlRecord(
    snapshots[`@agent-teams/docs-protocol@${String(docsSelection)}`],
    "pnpm-lock.yaml#snapshots.docs-protocol"
  );
  const docsDependencies = yamlRecord(
    docsSnapshot["dependencies"],
    "pnpm-lock.yaml#snapshots.docs-protocol.dependencies"
  );
  if (!validPnpmPeerContext(
    docsDependencies["@agent-teams/engineering-foundation"],
    desired.cohort.packages.engineeringFoundation.version
  )) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH",
      "The selected Docs Protocol snapshot must depend on the exact cohort Foundation version."
    );
  }
  assertRegistryBoundRuntimeClosure(lockfile, desired);
  return observation;
}

export async function readConsumerIntegrationInput(options: {
  readonly consumerRoot: string;
  readonly integrationProfilePath?: string;
}): Promise<{
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly root: string;
  readonly snapshot: ConsumerIntegrationSnapshot;
}> {
  const root = await canonicalRoot(options.consumerRoot);
  await assertGitRepositoryRoot(root);
  const topology = await scanConsumerRepositoryTopology(root);
  assertSingleIntegrationTopology(topology);
  await assertQualifiedPnpmRoot(root);
  const profilePath = options.integrationProfilePath ?? INTEGRATION_PROFILE_PATH;
  if (profilePath !== INTEGRATION_PROFILE_PATH) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PROFILE_PATH_UNSUPPORTED",
      `V1 requires the integration profile at ${INTEGRATION_PROFILE_PATH}.`
    );
  }
  const profile = await readStableFile(
    root,
    profilePath,
    MAXIMUM_PROFILE_BYTES,
    true
  );
  if (profile.state !== "file") {throw new Error("unreachable");}
  let desired: ConsumerIntegrationDesiredStateV1;
  let lockfile: ConsumerIntegrationFileObservation;
  try {
    desired = parseJsonRecord(
      Buffer.from(profile.bytes).toString("utf8")
    ) as unknown as ConsumerIntegrationDesiredStateV1;
    rejectPrototypeKeys(desired);
    await assertConsumerIntegrationProfileSchema(desired);
    assertNestedAgentsAuthority(topology, desired.governedDocsRoots);
    assertGitHubRuntimeIdentity(desired);
    lockfile = await assertQualifiedLockfile(root, desired);
  } catch (error) {
    if (error instanceof ConsumerIntegrationNodeError) {throw error;}
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PROFILE_INVALID",
      error instanceof Error ? error.message : "Integration profile is invalid.",
      { cause: error }
    );
  }
  const [packageManifest, agents, skill, callerWorkflow, managedState] = await Promise.all([
    readStableFile(root, "package.json", MAXIMUM_MANIFEST_BYTES, true),
    readStableFile(root, "AGENTS.md", MAXIMUM_MANAGED_ASSET_BYTES, false),
    readStableFile(root, desired.skillPath, MAXIMUM_MANAGED_ASSET_BYTES, false),
    readStableFile(root, desired.callerWorkflowPath, MAXIMUM_MANAGED_ASSET_BYTES, false),
    readStableFile(root, desired.managedStatePath, MAXIMUM_MANAGED_ASSET_BYTES, false)
  ]);
  const snapshot = {
    integrationProfile: profile,
    lockfile,
    packageManifest,
    agents,
    skill,
    callerWorkflow,
    managedState
  };
  await assertSnapshotStillStable({ root, desired, snapshot });
  return {
    desired,
    root,
    snapshot
  };
}

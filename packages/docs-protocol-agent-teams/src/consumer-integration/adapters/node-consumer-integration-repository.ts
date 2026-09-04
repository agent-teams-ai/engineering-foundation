import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationFileObservation,
  ConsumerIntegrationSnapshot
} from "../domain/model.js";
import type {
  ConsumerIntegrationInputReader
} from "../application/ports/consumer-integration-lifecycle.js";
import { assertConsumerIntegrationProfileSchema } from "./consumer-integration-schema-validator.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { assertQualifiedPnpmLockfileV1 } from "./pnpm-lockfile-validator-v1.js";
import { assertQualifiedPnpmLockfileV2 } from "./pnpm-lockfile-validator-v2.js";
import { parseJsonRecord } from "./strict-json-record.js";
import {
  scanConsumerRepositoryTopology,
  type ConsumerRepositoryTopology
} from "./bounded-repository-topology.js";
import {
  canonicalConsumerRoot,
  INTEGRATION_PROFILE_PATH,
  MAXIMUM_LOCKFILE_BYTES,
  MAXIMUM_MANAGED_ASSET_BYTES,
  MAXIMUM_MANIFEST_BYTES,
  MAXIMUM_PROFILE_BYTES,
  readStableConsumerFile,
  sameConsumerFileObservation
} from "./node-consumer-repository-files.js";

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

export { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

function assertSingleIntegrationTopology(topology: ConsumerRepositoryTopology): void {
  if (topology.lockfiles.length !== 1 || topology.lockfiles[0] !== "pnpm-lock.yaml") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_NESTED_LOCKFILE_UNSUPPORTED",
      "Managed consumer integration requires exactly one root pnpm-lock.yaml and no nested lockfiles."
    );
  }
  if (topology.integrationProfiles.length !== 1 ||
    topology.integrationProfiles[0] !== INTEGRATION_PROFILE_PATH) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_MULTIPLE_INTEGRATION_UNITS",
      `Managed consumer integration requires exactly one profile at ${INTEGRATION_PROFILE_PATH}.`
    );
  }
  if (topology.pnpmfiles.length > 0) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PNPMFILE_UNSUPPORTED",
      "Managed consumer integration does not permit .pnpmfile.cjs."
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

async function exactGitHead(root: string): Promise<string | undefined> {
  let head: string;
  try {
    head = (await executeGit(root, ["rev-parse", "--verify", "HEAD"], 64 * 1024)).trim();
  } catch {
    return undefined;
  }
  if (!/^(?!0{40}$)[0-9a-f]{40}$/u.test(head)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_GIT_INVALID",
      "Consumer repository must have one exact Git HEAD."
    );
  }
  return head;
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

function assertGitHubRuntimeIdentity(desired: ConsumerIntegrationDesiredState): void {
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
      "Managed consumer check and plan require Node >=24.18.0 <25."
    );
  }
  const manifestObservation = await readStableConsumerFile(
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
      "Managed consumer integration requires an exact root packageManager within >=11.17.0 <12."
    );
  }
  const nodeVersion = await readStableConsumerFile(root, ".node-version", 128, true);
  if (nodeVersion.state !== "file" ||
    !/^24\.(?:1[89]|[2-9][0-9])\.[0-9]+\n?$/u.test(Buffer.from(nodeVersion.bytes).toString("utf8"))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_NODE_VERSION_GATE_INVALID",
      ".node-version must pin one exact Node version within >=24.18.0 <25."
    );
  }
  await readStableConsumerFile(root, "pnpm-lock.yaml", MAXIMUM_LOCKFILE_BYTES, true);
  for (const path of ["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
    if ((await readStableConsumerFile(root, path, 1024, false)).state !== "absent") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UNSUPPORTED_PACKAGE_MANAGER",
        `Multiple or unsupported package-manager evidence is present: ${path}.`
      );
    }
  }
}

async function assertSnapshotStillStable(input: {
  readonly root: string;
  readonly desired: ConsumerIntegrationDesiredState;
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
    readStableConsumerFile(input.root, path, maximum, required)
  ));
  const unstable = paths.find(([key], index) =>
    !sameConsumerFileObservation(input.snapshot[key], reread[index]!)
  );
  if (unstable !== undefined) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_SNAPSHOT_UNSTABLE",
      `Consumer integration input changed while the repository snapshot was assembled: ${unstable[1]}.`
    );
  }
}

async function assertQualifiedLockfile(
  root: string,
  desired: ConsumerIntegrationDesiredState
): Promise<ConsumerIntegrationFileObservation> {
  const observation = await readStableConsumerFile(
    root,
    "pnpm-lock.yaml",
    MAXIMUM_LOCKFILE_BYTES,
    true
  );
  if (observation.state !== "file") {throw new Error("unreachable");}
  switch (desired.schemaVersion) {
    case 1:
      assertQualifiedPnpmLockfileV1(observation.bytes, desired);
      break;
    case 3:
      assertQualifiedPnpmLockfileV2(observation.bytes, desired);
      break;
  }
  return observation;
}

export async function readManagedConsumerIntegrationInput(options: {
  readonly consumerRoot: string;
  readonly integrationProfilePath?: string;
}): Promise<{
  readonly desired: ConsumerIntegrationDesiredState;
  readonly repositoryHead?: string;
  readonly root: string;
  readonly snapshot: ConsumerIntegrationSnapshot;
}> {
  const root = await canonicalConsumerRoot(options.consumerRoot);
  await assertGitRepositoryRoot(root);
  const repositoryHead = await exactGitHead(root);
  const topology = await scanConsumerRepositoryTopology(root);
  assertSingleIntegrationTopology(topology);
  await assertQualifiedPnpmRoot(root);
  const profilePath = options.integrationProfilePath ?? INTEGRATION_PROFILE_PATH;
  if (profilePath !== INTEGRATION_PROFILE_PATH) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PROFILE_PATH_UNSUPPORTED",
      `Managed consumer integration requires the profile at ${INTEGRATION_PROFILE_PATH}.`
    );
  }
  const profile = await readStableConsumerFile(
    root,
    profilePath,
    MAXIMUM_PROFILE_BYTES,
    true
  );
  if (profile.state !== "file") {throw new Error("unreachable");}
  let desired: ConsumerIntegrationDesiredState;
  let lockfile: ConsumerIntegrationFileObservation;
  try {
    const parsed = parseJsonRecord(
      Buffer.from(profile.bytes).toString("utf8")
    ) as unknown as (
      | (Omit<ConsumerIntegrationDesiredStateV1, "schemaVersion"> & {
          readonly schemaVersion: 1 | 2;
          readonly qualification?: unknown;
        })
      | ConsumerIntegrationDesiredStateV3
    );
    rejectPrototypeKeys(parsed);
    await assertConsumerIntegrationProfileSchema(parsed);
    switch (parsed.schemaVersion) {
      case 1:
        desired = parsed as ConsumerIntegrationDesiredStateV1;
        break;
      case 2: {
        const { qualification: _qualification, ...v1 } = parsed;
        desired = { ...v1, schemaVersion: 1 };
        break;
      }
      case 3:
        desired = parsed;
        break;
    }
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
    readStableConsumerFile(root, "package.json", MAXIMUM_MANIFEST_BYTES, true),
    readStableConsumerFile(root, "AGENTS.md", MAXIMUM_MANAGED_ASSET_BYTES, false),
    readStableConsumerFile(root, desired.skillPath, MAXIMUM_MANAGED_ASSET_BYTES, false),
    readStableConsumerFile(root, desired.callerWorkflowPath, MAXIMUM_MANAGED_ASSET_BYTES, false),
    readStableConsumerFile(root, desired.managedStatePath, MAXIMUM_MANAGED_ASSET_BYTES, false)
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
  if (await exactGitHead(root) !== repositoryHead) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_SNAPSHOT_UNSTABLE",
      "Consumer Git HEAD changed while the repository snapshot was assembled."
    );
  }
  return {
    desired,
    ...(repositoryHead === undefined ? {} : { repositoryHead }),
    root,
    snapshot
  };
}

export async function readConsumerIntegrationInput(options: {
  readonly consumerRoot: string;
  readonly integrationProfilePath?: string;
}): Promise<{
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly root: string;
  readonly snapshot: ConsumerIntegrationSnapshot;
}> {
  const { desired, root, snapshot } = await readManagedConsumerIntegrationInput(options);
  if (desired.schemaVersion !== 1) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PROFILE_INVALID",
      "The legacy public reader accepts only consumer integration profile V1/V2."
    );
  }
  return { desired, root, snapshot };
}

export const nodeConsumerIntegrationInputReader: ConsumerIntegrationInputReader =
  Object.freeze({ read: readManagedConsumerIntegrationInput });

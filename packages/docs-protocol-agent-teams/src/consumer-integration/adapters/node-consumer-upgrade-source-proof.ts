import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

import type {
  ConsumerUpgradeManagedPreimagesV2
} from "../application/ports/consumer-upgrade.js";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationSnapshot
} from "../domain/model.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import {
  INTEGRATION_PROFILE_PATH,
  MAXIMUM_LOCKFILE_BYTES,
  MAXIMUM_MANAGED_ASSET_BYTES,
  MAXIMUM_MANIFEST_BYTES,
  MAXIMUM_PROFILE_BYTES,
  readStableConsumerFile,
  sameConsumerFileObservation
} from "./node-consumer-repository-files.js";

type UpgradeDesiredState = ConsumerIntegrationDesiredStateV1 | ConsumerIntegrationDesiredStateV3;
const WORKSPACE_PATH = "pnpm-workspace.yaml";

export async function assertCleanConsumerGitSource(
  root: string,
  execute: (executable: string, args: readonly string[], cwd: string) => Promise<{
    readonly stdout: string;
  }>
): Promise<string> {
  const status = await execute(
    "git",
    [
      "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
      ":(exclude).agent-teams-local", ":(exclude).agent-teams-local/**"
    ],
    root
  );
  if (status.stdout !== "") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_DIRTY_WORKTREE",
      "One-command Cohort upgrade requires a clean consumer Git worktree."
    );
  }
  const head = (await execute("git", ["rev-parse", "HEAD"], root)).stdout.trim();
  if (!/^(?!0{40}$)[0-9a-f]{40}$/u.test(head)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_GIT_INVALID",
      "Consumer worktree must have one exact Git HEAD."
    );
  }
  return head;
}

export function allowedUpgradePaths(current: UpgradeDesiredState): ReadonlySet<string> {
  return new Set([
    "AGENTS.md",
    INTEGRATION_PROFILE_PATH,
    "package.json",
    "pnpm-lock.yaml",
    WORKSPACE_PATH,
    current.skillPath,
    current.callerWorkflowPath,
    current.managedStatePath
  ]);
}

function contained(root: string, repositoryPath: string): string {
  const path = resolvePath(root, repositoryPath);
  const relation = relative(root, path);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PATH_ESCAPE",
      `Upgrade path escapes the disposable repository: ${repositoryPath}.`
    );
  }
  return path;
}

export async function assertProvedSourceSnapshot(input: {
  readonly current: UpgradeDesiredState;
  readonly expected: ConsumerIntegrationSnapshot;
  readonly sourceRoot: string;
}): Promise<void> {
  const definitions = [
    ["integrationProfile", INTEGRATION_PROFILE_PATH, MAXIMUM_PROFILE_BYTES, true],
    ["lockfile", "pnpm-lock.yaml", MAXIMUM_LOCKFILE_BYTES, true],
    ["packageManifest", "package.json", MAXIMUM_MANIFEST_BYTES, true],
    ["agents", "AGENTS.md", MAXIMUM_MANAGED_ASSET_BYTES, false],
    ["skill", input.current.skillPath, MAXIMUM_MANAGED_ASSET_BYTES, false],
    ["callerWorkflow", input.current.callerWorkflowPath, MAXIMUM_MANAGED_ASSET_BYTES, false],
    ["managedState", input.current.managedStatePath, MAXIMUM_MANAGED_ASSET_BYTES, false]
  ] as const;
  for (const [key, path, byteLimit, required] of definitions) {
    const observed = await readStableConsumerFile(
      input.sourceRoot,
      path,
      byteLimit,
      required
    );
    if (!sameConsumerFileObservation(input.expected[key], observed)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
        `Committed source differs from the proved source snapshot: ${path}.`
      );
    }
  }
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function resetProvedManagedAssetsV2(input: {
  readonly current: ConsumerIntegrationDesiredStateV3;
  readonly managedPreimages: ConsumerUpgradeManagedPreimagesV2;
  readonly stagedRoot: string;
}): Promise<void> {
  const entries = [
    [input.current.callerWorkflowPath, input.managedPreimages.callerWorkflow],
    [input.current.managedStatePath, input.managedPreimages.managedState],
    [input.current.skillPath, input.managedPreimages.skill]
  ] as const;
  if (new Set(entries.map(([path]) => path)).size !== entries.length) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
      "Managed source asset paths are not distinct."
    );
  }
  for (const [path, proof] of entries) {
    if (proof.path !== path) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
        `Managed source asset proof path differs from the profile: ${path}.`
      );
    }
    const observed = await readStableConsumerFile(
      input.stagedRoot,
      path,
      MAXIMUM_MANAGED_ASSET_BYTES,
      true
    );
    if (observed.state !== "file" || observed.mode !== proof.mode ||
      sha256(observed.bytes) !== proof.digest) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
        `Managed source asset differs from the proved source plan: ${path}.`
      );
    }
  }
  await Promise.all(entries.map(([path]) => rm(contained(input.stagedRoot, path))));
}

export async function assertManagedAssetsCreatedV2(
  root: string,
  current: ConsumerIntegrationDesiredStateV3
): Promise<void> {
  await Promise.all([
    current.callerWorkflowPath,
    current.managedStatePath,
    current.skillPath
  ].map((path) => readStableConsumerFile(
    root,
    path,
    MAXIMUM_MANAGED_ASSET_BYTES,
    true
  )));
}

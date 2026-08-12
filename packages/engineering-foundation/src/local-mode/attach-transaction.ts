import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { FoundationError } from "../errors.js";
import {
  inspectFoundationPackage,
  parseFoundationPackageSelfCheck
} from "../package-self-check.js";
import { isExactVersion } from "../semantic-version.js";
import { inspectFoundationMode } from "./inspection.js";
import {
  removeLinkState,
  syncDirectory,
  writeLinkState
} from "./local-state-store.js";
import { createNodeFoundationTransactionCoordinator } from "../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import {
  pathEntryExists,
  resolveTargetPackageRoot,
  restoreRegistryEntry
} from "./registry-recovery.js";
import type {
  AttachResult,
  FoundationLinkState,
  FoundationStatus,
  ProcessRunner
} from "./types.js";
import {
  FOUNDATION_PACKAGE_NAME,
  LOCAL_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY
} from "./types.js";

interface AttachTransactionInput {
  readonly consumerPath: string;
  readonly targetPath: string;
  readonly runner: ProcessRunner;
  readonly now: () => Date;
  readonly readStatus: (
    consumerPath: string,
    ignoreOperationLock: boolean
  ) => Promise<FoundationStatus>;
}

interface AttachConsumerState {
  readonly consumerRoot: string;
  readonly dependencySpec: string;
  readonly registryPackageRoot: string;
}

interface AttachPreparation extends AttachConsumerState {
  readonly targetPackageRoot: string;
  readonly packageVersion: string;
  readonly gitCommit: string;
  readonly gitDirty: boolean;
}

type AttachPreparationFailureCode = "CONSUMER_INVALID" | "LOCAL_STATE_INVALID";

async function verifyTargetPackage(
  input: AttachTransactionInput,
  consumerRoot: string
): Promise<{ readonly targetPackageRoot: string; readonly packageVersion: string }> {
  const targetPackageRoot = await resolveTargetPackageRoot(input.targetPath);
  if (targetPackageRoot === consumerRoot) {
    throw new FoundationError("PACKAGE_INVALID", "Foundation target cannot be the consumer repository.");
  }
  const expected = await inspectFoundationPackage(targetPackageRoot);
  const result = await input.runner.run({
    command: process.execPath,
    args: [join(targetPackageRoot, "dist", "cli.js"), "self-check", "--json"],
    cwd: targetPackageRoot
  });
  let actual;
  try {
    actual = parseFoundationPackageSelfCheck(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target CLI self-check did not return a valid result.",
      { cause: error }
    );
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target CLI self-check disagrees with package metadata."
    );
  }
  return { targetPackageRoot, packageVersion: expected.packageVersion };
}

async function readGitEvidence(
  runner: ProcessRunner,
  consumerRoot: string,
  targetPackageRoot: string
): Promise<{ readonly gitCommit: string; readonly gitDirty: boolean }> {
  const gitCommit = (await runner.run({
    command: "git",
    args: ["-C", targetPackageRoot, "rev-parse", "HEAD"],
    cwd: consumerRoot
  })).stdout.trim();
  const gitDirty = (await runner.run({
    command: "git",
    args: ["-C", targetPackageRoot, "status", "--porcelain"],
    cwd: consumerRoot
  })).stdout.trim().length > 0;
  return { gitCommit, gitDirty };
}

async function ensureStateDirectoryIgnored(
  runner: ProcessRunner,
  consumerRoot: string
): Promise<void> {
  const result = await runner.run({
    command: "git",
    args: ["-C", consumerRoot, "rev-parse", "--git-path", "info/exclude"],
    cwd: consumerRoot
  });
  const candidate = result.stdout.trim();
  const excludePath = isAbsolute(candidate) ? candidate : resolve(consumerRoot, candidate);
  await mkdir(dirname(excludePath), { recursive: true });
  const exclude = await readFile(excludePath, "utf8").catch(() => "");
  if (exclude.split(/\r?\n/u).includes(`${LOCAL_STATE_DIRECTORY}/`)) {
    return;
  }
  const separator = exclude.length === 0 || exclude.endsWith("\n") ? "" : "\n";
  await appendFile(excludePath, `${separator}${LOCAL_STATE_DIRECTORY}/\n`, "utf8");
}

async function inspectAttachConsumerState(
  input: AttachTransactionInput,
  failureCode: AttachPreparationFailureCode,
  expected?: Pick<AttachConsumerState, "consumerRoot" | "dependencySpec">
): Promise<AttachConsumerState> {
  const before = await inspectFoundationMode(input.consumerPath, { ignoreOperationLock: true });
  if (
    before.mode !== "REGISTRY" ||
    before.dependencySpec === undefined ||
    !isExactVersion(before.dependencySpec) ||
    before.installedPackageRoot === undefined
  ) {
    throw new FoundationError(
      failureCode,
      failureCode === "CONSUMER_INVALID"
        ? `Consumer must be in valid registry mode with an exact ${FOUNDATION_PACKAGE_NAME} version before attach: ${before.issues.join(" ") || before.mode}.`
        : "Consumer foundation state changed before attach acquired its operation lock."
    );
  }
  if (
    expected !== undefined &&
    (before.consumerRoot !== expected.consumerRoot ||
      before.dependencySpec !== expected.dependencySpec)
  ) {
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Consumer foundation state changed before attach acquired its operation lock."
    );
  }
  return {
    consumerRoot: before.consumerRoot,
    dependencySpec: before.dependencySpec,
    registryPackageRoot: before.installedPackageRoot
  };
}

async function prepareAttach(
  input: AttachTransactionInput,
  consumer: AttachConsumerState
): Promise<AttachPreparation> {
  const target = await verifyTargetPackage(input, consumer.consumerRoot);
  const git = await readGitEvidence(
    input.runner,
    consumer.consumerRoot,
    target.targetPackageRoot
  );
  return {
    ...consumer,
    ...target,
    ...git
  };
}

function createAttachingState(
  preparation: AttachPreparation,
  registryPackageRoot: string,
  registryEntryKind: FoundationLinkState["registryEntryKind"],
  now: () => Date
): FoundationLinkState {
  return {
    schemaVersion: 1,
    phase: "ATTACHING",
    consumerRoot: preparation.consumerRoot,
    targetPackageRoot: preparation.targetPackageRoot,
    registryBackupPath: join(
      preparation.consumerRoot,
      LOCAL_STATE_DIRECTORY,
      LOCAL_REGISTRY_BACKUP
    ),
    registryEntryKind,
    registryPackageRoot,
    packageVersion: preparation.packageVersion,
    gitCommit: preparation.gitCommit,
    gitDirty: preparation.gitDirty,
    attachedAt: now().toISOString()
  };
}

async function replaceRegistryEntryWithLink(
  state: FoundationLinkState,
  installedPackagePath: string
): Promise<void> {
  if (state.registryEntryKind === "symbolic-link") {
    await symlink(
      state.registryPackageRoot,
      state.registryBackupPath,
      process.platform === "win32" ? "junction" : "dir"
    );
    await syncDirectory(dirname(state.registryBackupPath));
    await rm(installedPackagePath, { force: true });
  } else {
    await rename(installedPackagePath, state.registryBackupPath);
    await syncDirectory(dirname(state.registryBackupPath));
  }
  await syncDirectory(dirname(installedPackagePath));
  await mkdir(dirname(installedPackagePath), { recursive: true });
  await symlink(
    state.targetPackageRoot,
    installedPackagePath,
    process.platform === "win32" ? "junction" : "dir"
  );
  if ((await realpath(installedPackagePath)) !== state.targetPackageRoot) {
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Local package link does not resolve to the requested target."
    );
  }
  await syncDirectory(dirname(installedPackagePath));
}

async function recoverFailedAttach(
  preparation: AttachPreparation,
  state: FoundationLinkState,
  failure: unknown
): Promise<never> {
  const recoveryErrors: unknown[] = [];
  try {
    await restoreRegistryEntry(preparation.consumerRoot, preparation.dependencySpec, state);
  } catch (error) {
    recoveryErrors.push(error);
  }
  try {
    await removeLinkState(preparation.consumerRoot);
  } catch (error) {
    recoveryErrors.push(error);
  }
  if (recoveryErrors.length > 0) {
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Local attach failed and its registry state could not be fully restored.",
      { cause: new AggregateError([failure, ...recoveryErrors], "Attach and one or more recovery operations failed.") }
    );
  }
  throw new FoundationError(
    "LOCAL_STATE_INVALID",
    "Local attach failed and the registry installation was restored.",
    { cause: failure }
  );
}

async function commitAttach(
  input: AttachTransactionInput,
  preflight: AttachConsumerState
): Promise<AttachResult> {
  let preparation: AttachPreparation | undefined;
  let state: FoundationLinkState | undefined;
  try {
    const consumer = await inspectAttachConsumerState(
      input,
      "LOCAL_STATE_INVALID",
      preflight
    );
    preparation = await prepareAttach(input, consumer);
    const installedPath = join(
      preparation.consumerRoot,
      "node_modules",
      FOUNDATION_PACKAGE_NAME
    );
    const backupPath = join(
      preparation.consumerRoot,
      LOCAL_STATE_DIRECTORY,
      LOCAL_REGISTRY_BACKUP
    );
    if (await pathEntryExists(backupPath)) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "A registry backup already exists; run detach to recover it before attaching."
      );
    }
    const registryEntry = await lstat(installedPath);
    if (!registryEntry.isDirectory() && !registryEntry.isSymbolicLink()) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Installed foundation entry is neither a directory nor a symbolic link."
      );
    }
    if ((await realpath(installedPath)) !== preparation.registryPackageRoot) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Installed foundation entry changed before attach could replace it."
      );
    }
    await ensureStateDirectoryIgnored(input.runner, preparation.consumerRoot);
    state = createAttachingState(
      preparation,
      preparation.registryPackageRoot,
      registryEntry.isSymbolicLink() ? "symbolic-link" : "directory",
      input.now
    );
    await writeLinkState(preparation.consumerRoot, state);
    await replaceRegistryEntryWithLink(state, installedPath);
    state = { ...state, phase: "LOCAL" };
    await writeLinkState(preparation.consumerRoot, state);
    const status = await input.readStatus(preparation.consumerRoot, true);
    if (status.mode !== "LOCAL") {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        `Local attach verification failed: ${status.issues.join(" ")}`
      );
    }
    return { status, targetPackageRoot: preparation.targetPackageRoot };
  } catch (error) {
    if (state === undefined || preparation === undefined) {
      throw error;
    }
    return await recoverFailedAttach(preparation, state, error);
  }
}

export async function attachFoundation(
  input: AttachTransactionInput
): Promise<AttachResult> {
  const coordinator = await createNodeFoundationTransactionCoordinator(
    input.consumerPath
  );
  const lease = await coordinator.acquire({ requestedMutation: "attach" });
  try {
    const preflight = await inspectAttachConsumerState(
      input,
      "CONSUMER_INVALID"
    );
    return await commitAttach(input, preflight);
  } finally {
    await lease.release({
      retainTransactionBarrier: (await coordinator.inspect()).state !== "idle"
    });
  }
}

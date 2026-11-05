import { lstat, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  localCustodyFailure,
  invalidRecoveryManifest,
  recoveryPathsOutsideConsumer,
  invalidRegistryBackup,
  unprovenRegistryEntry,
  missingTargetPackage,
} from "../../application/inspection-failures.js";
import { readBoundedConsumerManifest } from "./bun-registry-inspection.js";
import {
  assertLocalEntry,
  localLinkPointsTo,
  observeLocalEntry,
  observeLocalParents,
  sameLocalEntry,
  type LocalEntryObservation,
} from "./local-entry-observation.js";
import type { FoundationLinkState } from "../../application/model.js";
import {
  FOUNDATION_PACKAGE_NAME,
  LOCAL_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY,
} from "../../application/model.js";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  const value = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRecoveryManifest(path);
  }
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function readPackageEntry(path: string) {
  const entry = await observeLocalEntry(path);
  if (
    entry.metadata === undefined ||
    (!entry.metadata.isDirectory() && !entry.metadata.isSymbolicLink())
  ) {
    throw invalidRegistryBackup();
  }
  const packageRoot = await realpath(path);
  const manifestEntry = await observeLocalEntry(join(packageRoot, "package.json"));
  const value = await readBoundedConsumerManifest(packageRoot);
  const manifest: PackageManifest = value;
  await assertLocalEntry(manifestEntry);
  await assertLocalEntry(entry);
  return { manifest, packageRoot, entry, manifestEntry };
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertRecoveryStatePaths(consumerRoot: string, state: FoundationLinkState): void {
  const backupPath = join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_REGISTRY_BACKUP);
  if (
    resolve(state.consumerRoot) !== consumerRoot ||
    resolve(state.registryBackupPath) !== backupPath ||
    !isWithin(join(consumerRoot, "node_modules"), resolve(state.registryPackageRoot))
  ) {
    throw recoveryPathsOutsideConsumer();
  }
}

function backupRootExpected(
  consumerRoot: string,
  backupRoot: string,
  backupPath: string,
  state: FoundationLinkState | undefined,
): boolean {
  if (state === undefined) {
    return backupRoot === backupPath || isWithin(join(consumerRoot, "node_modules"), backupRoot);
  }
  return (
    backupRoot ===
    (state.registryEntryKind === "directory" ? backupPath : resolve(state.registryPackageRoot))
  );
}

function provesRestoredRegistryEntry(
  installed: Awaited<ReturnType<typeof readPackageEntry>>,
  consumerRoot: string,
  dependencySpec: string,
  state: FoundationLinkState | undefined,
): boolean {
  const expectedRoot =
    state === undefined
      ? isWithin(join(consumerRoot, "node_modules"), installed.packageRoot)
      : installed.packageRoot === resolve(state.registryPackageRoot);
  return (
    expectedRoot &&
    installed.manifest.name === FOUNDATION_PACKAGE_NAME &&
    installed.manifest.version === dependencySpec
  );
}

async function observeRestoredRegistryEntry(backup: LocalEntryObservation, path: string) {
  const restored = await observeLocalEntry(path);
  if (
    backup.metadata === undefined ||
    restored.metadata === undefined ||
    !sameLocalEntry(backup.metadata, restored.metadata)
  ) {
    throw localCustodyFailure(
      "Restored registry entry ownership changed; recovery evidence was preserved.",
    );
  }
  return restored;
}

export async function restoreRegistryEntry(
  consumerRoot: string,
  dependencySpec: string,
  state: FoundationLinkState | undefined,
  syncDirectory: (path: string) => Promise<void>,
): Promise<void> {
  const installedPath = join(consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
  const backupPath = join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_REGISTRY_BACKUP);
  if (state !== undefined) {
    assertRecoveryStatePaths(consumerRoot, state);
  }
  if (await pathEntryExists(backupPath)) {
    const installedParents = await observeLocalParents(consumerRoot, dirname(installedPath));
    const backupParents = await observeLocalParents(consumerRoot, dirname(backupPath));
    const backup = await readPackageEntry(backupPath);
    if (
      backup.manifest.name !== FOUNDATION_PACKAGE_NAME ||
      backup.manifest.version !== dependencySpec ||
      !backupRootExpected(consumerRoot, backup.packageRoot, backupPath, state)
    ) {
      throw invalidRegistryBackup();
    }
    const packageParents = await observeLocalParents(consumerRoot, backup.packageRoot);
    const installed = await observeLocalEntry(installedPath);
    const localLink = state !== undefined && localLinkPointsTo(installed, state.targetPackageRoot);
    // Two symlinks to the same admitted registry directory can be interrupted
    // attach evidence. Complete without deleting the installed registry entry.
    const restoredLink =
      backup.entry.metadata.isSymbolicLink() && localLinkPointsTo(installed, backup.packageRoot);
    if (installed.metadata !== undefined && !localLink && !restoredLink) {
      throw localCustodyFailure(
        "Installed entry is not an admitted local link; replacement and backup were preserved.",
      );
    }
    const assertCurrent = async () => {
      await installedParents.assertCurrent();
      await backupParents.assertCurrent();
      await packageParents.assertCurrent();
      await assertLocalEntry(backup.entry);
      await assertLocalEntry(backup.manifestEntry);
      await assertLocalEntry(installed);
    };
    const assertRestored = async (
      entry: LocalEntryObservation,
      manifest: LocalEntryObservation,
    ) => {
      await installedParents.assertCurrent();
      await backupParents.assertCurrent();
      if (backup.entry.metadata.isSymbolicLink()) {
        await packageParents.assertCurrent();
      }
      await assertLocalEntry(entry);
      await assertLocalEntry(manifest);
      await assertLocalEntry({ path: backupPath, metadata: undefined });
    };
    await assertCurrent();
    if (restoredLink) {
      await rm(backupPath);
      await backupParents.assertCurrent();
      await syncDirectory(dirname(backupPath));
      await assertRestored(installed, backup.manifestEntry);
      return;
    }
    if (localLink) {
      // Never recurse. Even a last-moment directory substitution must not turn
      // a link removal into deletion of someone else's directory tree.
      await rm(installedPath);
    }
    await installedParents.assertCurrent();
    await backupParents.assertCurrent();
    await packageParents.assertCurrent();
    await assertLocalEntry(backup.entry);
    await assertLocalEntry(backup.manifestEntry);
    await assertLocalEntry({ path: installedPath, metadata: undefined });
    await rename(backupPath, installedPath);
    const restored = await observeRestoredRegistryEntry(backup.entry, installedPath);
    const manifest =
      backup.packageRoot === backupPath
        ? { ...backup.manifestEntry, path: join(installedPath, "package.json") }
        : backup.manifestEntry;
    await assertRestored(restored, manifest);
    await syncDirectory(dirname(installedPath));
    await syncDirectory(dirname(backupPath));
    await assertRestored(restored, manifest);
    return;
  }
  if (await pathEntryExists(installedPath)) {
    const installed = await readPackageEntry(installedPath).catch(() => {});
    if (
      installed !== undefined &&
      provesRestoredRegistryEntry(installed, consumerRoot, dependencySpec, state)
    ) {
      const installedParents = await observeLocalParents(consumerRoot, dirname(installedPath));
      await installedParents.assertCurrent();
      await assertLocalEntry({ path: backupPath, metadata: undefined });
      await assertLocalEntry(installed.entry);
      await assertLocalEntry(installed.manifestEntry);
      return;
    }
  }
  throw unprovenRegistryEntry();
}

export async function resolveTargetPackageRoot(targetPath: string): Promise<string> {
  const root = await realpath(resolve(targetPath));
  if (await pathExists(join(root, "package.json"))) {
    const manifest = await readPackageManifest(root);
    if (manifest.name === FOUNDATION_PACKAGE_NAME) {
      return root;
    }
  }
  const workspacePackage = join(root, "packages", "engineering-foundation");
  if (await pathExists(join(workspacePackage, "package.json"))) {
    const manifest = await readPackageManifest(workspacePackage);
    if (manifest.name === FOUNDATION_PACKAGE_NAME) {
      return await realpath(workspacePackage);
    }
  }
  throw missingTargetPackage();
}

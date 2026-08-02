import { lstat, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { FoundationError } from "../errors.js";
import { syncDirectory } from "./local-state-store.js";
import type { FoundationLinkState } from "./types.js";
import {
  FOUNDATION_PACKAGE_NAME,
  LOCAL_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY
} from "./types.js";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  const value = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FoundationError("PACKAGE_INVALID", `Invalid package.json at ${path}.`);
  }
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
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
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readPackageEntry(path: string): Promise<{
  readonly manifest: PackageManifest;
  readonly packageRoot: string;
}> {
  const packageRoot = await realpath(path);
  return { manifest: await readPackageManifest(packageRoot), packageRoot };
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
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Local recovery state contains paths outside its consumer-owned boundary."
    );
  }
}

function backupRootExpected(
  consumerRoot: string,
  backupRoot: string,
  backupPath: string,
  state: FoundationLinkState | undefined
): boolean {
  if (state === undefined) {
    return backupRoot === backupPath || isWithin(join(consumerRoot, "node_modules"), backupRoot);
  }
  return backupRoot === (state.registryEntryKind === "directory"
    ? backupPath
    : resolve(state.registryPackageRoot));
}

export async function restoreRegistryEntry(
  consumerRoot: string,
  dependencySpec: string,
  state: FoundationLinkState | undefined
): Promise<void> {
  const installedPath = join(consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
  const backupPath = join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_REGISTRY_BACKUP);
  if (state !== undefined) {
    assertRecoveryStatePaths(consumerRoot, state);
  }
  if (await pathEntryExists(backupPath)) {
    const backup = await readPackageEntry(backupPath);
    if (
      backup.manifest.name !== FOUNDATION_PACKAGE_NAME ||
      backup.manifest.version !== dependencySpec ||
      !backupRootExpected(consumerRoot, backup.packageRoot, backupPath, state)
    ) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Registry backup identity, version, or location is invalid."
      );
    }
    await rm(installedPath, { force: true, recursive: true });
    await mkdir(dirname(installedPath), { recursive: true });
    await rename(backupPath, installedPath);
    await syncDirectory(dirname(installedPath));
    await syncDirectory(dirname(backupPath));
    return;
  }
  if (await pathEntryExists(installedPath)) {
    const installed = await readPackageEntry(installedPath).catch(() => {});
    const expectedRoot = state === undefined
      ? installed !== undefined && isWithin(join(consumerRoot, "node_modules"), installed.packageRoot)
      : installed?.packageRoot === resolve(state.registryPackageRoot);
    if (
      installed !== undefined &&
      expectedRoot &&
      installed.manifest.name === FOUNDATION_PACKAGE_NAME &&
      installed.manifest.version === dependencySpec
    ) {
      return;
    }
  }
  throw new FoundationError(
    "LOCAL_STATE_INVALID",
    "Registry backup is unavailable and the installed package cannot be proven to be the original registry entry."
  );
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
  throw new FoundationError(
    "PACKAGE_INVALID",
    `Target does not contain ${FOUNDATION_PACKAGE_NAME}.`
  );
}

import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { FoundationError } from "../../application/errors/foundation-error.js";
import { pathEntryExists, restoreRegistryEntry } from "./registry-recovery.js";
import type { FoundationLinkState, ProcessRunner } from "../../application/model.js";
import { FOUNDATION_PACKAGE_NAME, LOCAL_REGISTRY_BACKUP, LOCAL_STATE_DIRECTORY } from "../../application/model.js";
import type { RegistryLinks } from "../../application/ports.js";

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

async function replaceRegistryEntryWithLink(
  state: FoundationLinkState,
  installedPackagePath: string,
  syncDirectory: (path: string) => Promise<void>
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

async function prepareRegistryEntry(consumerRoot: string, registryPackageRoot: string) {
  const installedPath = join(consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
  const backupPath = join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_REGISTRY_BACKUP);
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
    if ((await realpath(installedPath)) !== registryPackageRoot) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Installed foundation entry changed before attach could replace it."
      );
    }
  return {
    registryBackupPath: backupPath,
    registryEntryKind: registryEntry.isSymbolicLink() ? "symbolic-link" as const : "directory" as const
  };
}

export function createNodeRegistryLinks(runner: ProcessRunner, syncDirectory: (path: string) => Promise<void>): RegistryLinks {
  return {
    prepare: prepareRegistryEntry,
    ignoreLocalState: (consumerRoot) => ensureStateDirectoryIgnored(runner, consumerRoot),
    replace: (state) => replaceRegistryEntryWithLink(state, join(state.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME), syncDirectory),
    restore: (consumerRoot, dependencySpec, state) => restoreRegistryEntry(consumerRoot, dependencySpec, state, syncDirectory)
  };
}

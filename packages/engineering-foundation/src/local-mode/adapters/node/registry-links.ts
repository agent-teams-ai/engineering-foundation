import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  localCustodyFailure,
  localLinkTargetMismatch,
  registryBackupAlreadyExists,
  invalidInstalledEntry,
  installedEntryChanged,
} from "../../application/inspection-failures.js";
import { pathEntryExists, restoreRegistryEntry } from "./registry-recovery.js";
import type { FoundationLinkState, ProcessRunner } from "../../application/model.js";
import {
  FOUNDATION_PACKAGE_NAME,
  LOCAL_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY,
} from "../../application/model.js";
import {
  assertLocalEntry,
  observeLocalEntry,
  observeLocalParents,
  localLinkPointsTo,
  type LocalEntryObservation,
} from "./local-entry-observation.js";
import type { RegistryLinks } from "../../application/ports.js";

async function ensureStateDirectoryIgnored(
  runner: ProcessRunner,
  consumerRoot: string,
): Promise<void> {
  const result = await runner.run({
    command: "git",
    args: ["-C", consumerRoot, "rev-parse", "--git-path", "info/exclude"],
    cwd: consumerRoot,
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
  syncDirectory: (path: string) => Promise<void>,
  observation: {
    readonly installed: LocalEntryObservation;
    readonly assertParents: () => Promise<void>;
    readonly retainBackup: (entry: LocalEntryObservation) => void;
    readonly retainInstalled: (entry: LocalEntryObservation) => void;
  },
): Promise<void> {
  const installedPackagePath = observation.installed.path;
  await observation.assertParents();
  await assertLocalEntry(observation.installed);
  await assertLocalEntry({ path: state.registryBackupPath, metadata: undefined });
  if (state.registryEntryKind === "symbolic-link") {
    await symlink(
      state.registryPackageRoot,
      state.registryBackupPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  } else {
    await rename(installedPackagePath, state.registryBackupPath);
    observation.retainInstalled({ path: installedPackagePath, metadata: undefined });
  }
  const backup =
    state.registryEntryKind === "directory"
      ? { ...observation.installed, path: state.registryBackupPath }
      : await observeLocalEntry(state.registryBackupPath);
  observation.retainBackup(backup);
  await assertLocalEntry(backup);
  if (
    state.registryEntryKind === "symbolic-link" &&
    !localLinkPointsTo(backup, state.registryPackageRoot)
  ) {
    throw localCustodyFailure(
      "Published registry backup link does not match its admitted package.",
    );
  }
  await syncDirectory(dirname(state.registryBackupPath));
  await observation.assertParents();
  await assertLocalEntry(backup);
  if (state.registryEntryKind === "symbolic-link") {
    await assertLocalEntry(observation.installed);
    await rm(installedPackagePath);
    observation.retainInstalled({ path: installedPackagePath, metadata: undefined });
  }
  await syncDirectory(dirname(installedPackagePath));
  await observation.assertParents();
  await assertLocalEntry(backup);
  await assertLocalEntry({ path: installedPackagePath, metadata: undefined });
  await symlink(
    state.targetPackageRoot,
    installedPackagePath,
    process.platform === "win32" ? "junction" : "dir",
  );
  const local = await observeLocalEntry(installedPackagePath);
  observation.retainInstalled(local);
  if (
    !localLinkPointsTo(local, state.targetPackageRoot) ||
    (await realpath(installedPackagePath)) !== state.targetPackageRoot
  ) {
    throw localLinkTargetMismatch();
  }
  await syncDirectory(dirname(installedPackagePath));
  await observation.assertParents();
  await assertLocalEntry(backup);
  await assertLocalEntry(local);
}

async function prepareRegistryEntry(consumerRoot: string, registryPackageRoot: string) {
  const installedPath = join(consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
  const backupPath = join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_REGISTRY_BACKUP);
  if (await pathEntryExists(backupPath)) {
    throw registryBackupAlreadyExists();
  }
  const registryEntry = await lstat(installedPath);
  if (!registryEntry.isDirectory() && !registryEntry.isSymbolicLink()) {
    throw invalidInstalledEntry();
  }
  if ((await realpath(installedPath)) !== registryPackageRoot) {
    throw installedEntryChanged();
  }
  return {
    registryBackupPath: backupPath,
    registryEntryKind: registryEntry.isSymbolicLink()
      ? ("symbolic-link" as const)
      : ("directory" as const),
  };
}

export function createNodeRegistryLinks(
  runner: ProcessRunner,
  syncDirectory: (path: string) => Promise<void>,
): RegistryLinks {
  let publishedBackup: LocalEntryObservation | undefined;
  let installedForRecovery: LocalEntryObservation | undefined;
  let backupParentsForRecovery: Awaited<ReturnType<typeof observeLocalParents>> | undefined;
  let prepared:
    | {
        readonly root: string;
        readonly packageRoot: string;
        readonly installed: Awaited<ReturnType<typeof observeLocalEntry>>;
        readonly parents: Awaited<ReturnType<typeof observeLocalParents>>;
      }
    | undefined;
  return {
    async prepare(root, packageRoot) {
      const installedPath = join(root, "node_modules", FOUNDATION_PACKAGE_NAME);
      const parents = await observeLocalParents(root, dirname(installedPath));
      const installed = await observeLocalEntry(installedPath);
      const result = await prepareRegistryEntry(root, packageRoot);
      await parents.assertCurrent();
      await assertLocalEntry(installed);
      prepared = { root, packageRoot, installed, parents };
      installedForRecovery = installed;
      return result;
    },
    ignoreLocalState: (consumerRoot) => ensureStateDirectoryIgnored(runner, consumerRoot),
    async replace(state) {
      const admitted = prepared;
      if (
        admitted === undefined ||
        admitted.root !== state.consumerRoot ||
        admitted.packageRoot !== state.registryPackageRoot
      ) {
        throw localCustodyFailure("Registry replacement requires this operation's prepared entry.");
      }
      const backupParents = await observeLocalParents(
        state.consumerRoot,
        dirname(state.registryBackupPath),
      );
      backupParentsForRecovery = backupParents;
      await replaceRegistryEntryWithLink(state, syncDirectory, {
        installed: admitted.installed,
        assertParents: async () => {
          await admitted.parents.assertCurrent();
          await backupParents.assertCurrent();
        },
        retainBackup: (entry) => {
          publishedBackup = entry;
        },
        retainInstalled: (entry) => {
          installedForRecovery = entry;
        },
      });
    },
    async restore(consumerRoot, dependencySpec, state) {
      await prepared?.parents.assertCurrent();
      await backupParentsForRecovery?.assertCurrent();
      if (installedForRecovery !== undefined) {
        await assertLocalEntry(installedForRecovery);
      }
      if (publishedBackup !== undefined) {
        await assertLocalEntry(publishedBackup);
      }
      await restoreRegistryEntry(consumerRoot, dependencySpec, state, syncDirectory);
      publishedBackup = undefined;
      installedForRecovery = undefined;
      backupParentsForRecovery = undefined;
    },
  };
}

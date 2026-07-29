import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import { FoundationError } from "../errors.js";
import { inspectFoundationMode, isExactVersion } from "./inspection.js";
import type {
  AttachResult,
  FoundationLinkState,
  FoundationStatus,
  ProcessRunner
} from "./types.js";
import {
  FOUNDATION_PACKAGE_NAME,
  LOCAL_OPERATION_LOCK,
  LOCAL_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY,
  LOCAL_STATE_FILE
} from "./types.js";

const LOCAL_OPERATION_LOCK_OWNER = "owner.json";
const MAX_OPERATION_LOCK_AGE_MS = 10 * 60 * 1000;
const PARTIAL_OPERATION_LOCK_GRACE_MS = 30 * 1000;

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

interface OperationLock {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
}

export interface FoundationLocalModeServiceOptions {
  readonly runner: ProcessRunner;
  readonly now?: () => Date;
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

async function pathEntryExists(path: string): Promise<boolean> {
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

async function readPackageEntry(path: string): Promise<{
  readonly manifest: PackageManifest;
  readonly packageRoot: string;
}> {
  const packageRoot = await realpath(path);
  return {
    manifest: await readPackageManifest(packageRoot),
    packageRoot
  };
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function assertRecoveryStatePaths(
  consumerRoot: string,
  state: FoundationLinkState
): void {
  const expectedBackupPath = join(
    consumerRoot,
    LOCAL_STATE_DIRECTORY,
    LOCAL_REGISTRY_BACKUP
  );
  const nodeModulesRoot = join(consumerRoot, "node_modules");
  if (
    resolve(state.consumerRoot) !== consumerRoot ||
    resolve(state.registryBackupPath) !== expectedBackupPath ||
    !isWithin(nodeModulesRoot, resolve(state.registryPackageRoot))
  ) {
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Local recovery state contains paths outside its consumer-owned boundary."
    );
  }
}

async function resolveTargetPackageRoot(targetPath: string): Promise<string> {
  const root = await realpath(resolve(targetPath));
  const directManifest = join(root, "package.json");
  if (await pathExists(directManifest)) {
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

async function writeLinkState(
  consumerRoot: string,
  state: FoundationLinkState
): Promise<void> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await syncDirectory(directory);
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      return;
    }
    throw error;
  }
}

async function removeLinkState(consumerRoot: string): Promise<void> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  await rm(destination, { force: true });
  const temporaryEntries = await readdir(directory).catch(() => []);
  await Promise.all(
    temporaryEntries
      .filter(
        (entry) =>
          entry.startsWith(`${LOCAL_STATE_FILE}.`) && entry.endsWith(".tmp")
      )
      .map(async (entry) => {
        await rm(join(directory, entry), { force: true });
      })
  );
  await syncDirectory(directory);
  try {
    await rmdir(directory);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      return;
    }
    throw error;
  }
}

async function pruneLocalStateDirectory(consumerRoot: string): Promise<void> {
  try {
    await rmdir(join(consumerRoot, LOCAL_STATE_DIRECTORY));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      return;
    }
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function parseOperationLock(value: unknown): OperationLock | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    token: value.token,
    pid: value.pid,
    startedAt: value.startedAt
  };
}

async function acquireOperationLock(
  consumerRoot: string,
  now: () => Date
): Promise<() => Promise<void>> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const lockPath = join(directory, LOCAL_OPERATION_LOCK);
  const ownerPath = join(lockPath, LOCAL_OPERATION_LOCK_OWNER);
  await mkdir(directory, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        )
      ) {
        throw error;
      }

      const current = await readFile(ownerPath, "utf8")
        .then((content) => parseOperationLock(JSON.parse(content) as unknown))
        .catch(() => {});
      const lockStat = await stat(lockPath);
      const startedAt =
        current === undefined ? lockStat.mtimeMs : Date.parse(current.startedAt);
      const age = Math.max(
        0,
        now().getTime() - (Number.isFinite(startedAt) ? startedAt : lockStat.mtimeMs)
      );
      if (
        (current !== undefined &&
          processIsAlive(current.pid) &&
          age < MAX_OPERATION_LOCK_AGE_MS) ||
        (current === undefined && age < PARTIAL_OPERATION_LOCK_GRACE_MS)
      ) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          current === undefined
            ? "Another foundation operation is initializing."
            : `Another foundation operation is active in process ${current.pid}.`
        );
      }
      await rm(lockPath, { force: true, recursive: true });
      await syncDirectory(directory);
      continue;
    }

    try {
      const lock: OperationLock = {
        schemaVersion: 1,
        token,
        pid: process.pid,
        startedAt: now().toISOString()
      };
      const handle = await open(ownerPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(lockPath);

      return async () => {
        const current = await readFile(ownerPath, "utf8")
          .then((content) => parseOperationLock(JSON.parse(content) as unknown))
          .catch(() => {});
        if (current?.token === token) {
          await rm(lockPath, { force: true, recursive: true });
          await syncDirectory(directory);
        }
        await pruneLocalStateDirectory(consumerRoot);
      };
    } catch (error) {
      await rm(lockPath, { force: true, recursive: true });
      await syncDirectory(directory);
      throw error;
    }
  }

  throw new FoundationError(
    "LOCAL_STATE_INVALID",
    "Foundation operation lock could not be acquired."
  );
}

export class FoundationLocalModeService {
  readonly #runner: ProcessRunner;
  readonly #now: () => Date;

  constructor(options: FoundationLocalModeServiceOptions) {
    this.#runner = options.runner;
    this.#now = options.now ?? (() => new Date());
  }

  async #restoreRegistryEntry(
    consumerRoot: string,
    dependencySpec: string,
    state: FoundationLinkState | undefined
  ): Promise<void> {
    const installedPackagePath = join(
      consumerRoot,
      "node_modules",
      FOUNDATION_PACKAGE_NAME
    );
    const registryBackupPath = join(
      consumerRoot,
      LOCAL_STATE_DIRECTORY,
      LOCAL_REGISTRY_BACKUP
    );
    if (state !== undefined) {
      assertRecoveryStatePaths(consumerRoot, state);
    }

    if (await pathEntryExists(registryBackupPath)) {
      const backup = await readPackageEntry(registryBackupPath);
      const nodeModulesRoot = join(consumerRoot, "node_modules");
      const backupRootIsExpected =
        state === undefined
          ? backup.packageRoot === registryBackupPath ||
            isWithin(nodeModulesRoot, backup.packageRoot)
          : backup.packageRoot ===
            (state.registryEntryKind === "directory"
              ? registryBackupPath
              : resolve(state.registryPackageRoot));
      if (
        backup.manifest.name !== FOUNDATION_PACKAGE_NAME ||
        backup.manifest.version !== dependencySpec ||
        !backupRootIsExpected
      ) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Registry backup identity, version, or location is invalid."
        );
      }
      await rm(installedPackagePath, { force: true, recursive: true });
      await mkdir(dirname(installedPackagePath), { recursive: true });
      await rename(registryBackupPath, installedPackagePath);
      await syncDirectory(dirname(installedPackagePath));
      await syncDirectory(dirname(registryBackupPath));
      return;
    }

    if (await pathEntryExists(installedPackagePath)) {
      const installed = await readPackageEntry(installedPackagePath).catch(
        () => {}
      );
      if (
        installed !== undefined &&
        (state === undefined
          ? isWithin(join(consumerRoot, "node_modules"), installed.packageRoot)
          : installed.packageRoot === resolve(state.registryPackageRoot)) &&
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

  async #readStatus(
    consumerPath: string,
    ignoreOperationLock: boolean
  ): Promise<FoundationStatus> {
    const status = await inspectFoundationMode(consumerPath, {
      ignoreOperationLock
    });
    if (status.mode !== "LOCAL" || status.linkState === undefined) {
      return status;
    }

    try {
      const sourceGitCommit = (
        await this.#runner.run({
          command: "git",
          args: [
            "-C",
            status.linkState.targetPackageRoot,
            "rev-parse",
            "HEAD"
          ],
          cwd: status.consumerRoot
        })
      ).stdout.trim();
      const sourceGitDirty =
        (
          await this.#runner.run({
            command: "git",
            args: [
              "-C",
              status.linkState.targetPackageRoot,
              "status",
              "--porcelain"
            ],
            cwd: status.consumerRoot
          })
        ).stdout.trim().length > 0;
      return { ...status, sourceGitCommit, sourceGitDirty };
    } catch (error) {
      return {
        ...status,
        mode: "INVALID",
        issues: [
          ...status.issues,
          `Local foundation Git evidence is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        ]
      };
    }
  }

  async status(consumerPath: string): Promise<FoundationStatus> {
    return await this.#readStatus(consumerPath, false);
  }

  async attach(
    consumerPath: string,
    targetPath: string
  ): Promise<AttachResult> {
    const before = await inspectFoundationMode(consumerPath, {
      ignoreOperationLock: true
    });
    if (
      before.mode !== "REGISTRY" ||
      before.dependencySpec === undefined ||
      !isExactVersion(before.dependencySpec)
    ) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Consumer must be in valid registry mode with an exact ${FOUNDATION_PACKAGE_NAME} version before attach.`
      );
    }

    const consumerRoot = before.consumerRoot;
    const targetPackageRoot = await resolveTargetPackageRoot(targetPath);
    if (targetPackageRoot === consumerRoot) {
      throw new FoundationError(
        "PACKAGE_INVALID",
        "Foundation target cannot be the consumer repository."
      );
    }

    const targetManifest = await readPackageManifest(targetPackageRoot);
    if (
      targetManifest.name !== FOUNDATION_PACKAGE_NAME ||
      typeof targetManifest.version !== "string"
    ) {
      throw new FoundationError(
        "PACKAGE_INVALID",
        "Foundation target package identity or version is invalid."
      );
    }
    for (const output of ["dist/cli.js", "dist/index.js"]) {
      if (!(await pathExists(join(targetPackageRoot, output)))) {
        throw new FoundationError(
          "PACKAGE_INVALID",
          `Foundation target is not built: missing ${output}.`
        );
      }
    }

    const gitCommit = (
      await this.#runner.run({
        command: "git",
        args: ["-C", targetPackageRoot, "rev-parse", "HEAD"],
        cwd: consumerRoot
      })
    ).stdout.trim();
    const gitDirty =
      (
        await this.#runner.run({
          command: "git",
          args: ["-C", targetPackageRoot, "status", "--porcelain"],
          cwd: consumerRoot
        })
      ).stdout.trim().length > 0;

    const excludeResult = await this.#runner.run({
      command: "git",
      args: ["-C", consumerRoot, "rev-parse", "--git-path", "info/exclude"],
      cwd: consumerRoot
    });
    const excludePathCandidate = excludeResult.stdout.trim();
    const excludePath = isAbsolute(excludePathCandidate)
      ? excludePathCandidate
      : resolve(consumerRoot, excludePathCandidate);
    await mkdir(dirname(excludePath), { recursive: true });
    const exclude = await readFile(excludePath, "utf8").catch(() => "");
    if (!exclude.split(/\r?\n/u).includes(`${LOCAL_STATE_DIRECTORY}/`)) {
      const separator =
        exclude.length === 0 || exclude.endsWith("\n") ? "" : "\n";
      await appendFile(
        excludePath,
        `${separator}${LOCAL_STATE_DIRECTORY}/\n`,
        "utf8"
      );
    }

    const installedPackagePath = join(
      consumerRoot,
      "node_modules",
      FOUNDATION_PACKAGE_NAME
    );
    const registryBackupPath = join(
      consumerRoot,
      LOCAL_STATE_DIRECTORY,
      LOCAL_REGISTRY_BACKUP
    );
    const releaseLock = await acquireOperationLock(consumerRoot, this.#now);
    let state: FoundationLinkState | undefined;
    try {
      const current = await inspectFoundationMode(consumerRoot, {
        ignoreOperationLock: true
      });
      if (
        current.mode !== "REGISTRY" ||
        current.dependencySpec !== before.dependencySpec ||
        current.installedPackageRoot === undefined
      ) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Consumer foundation state changed before attach acquired its operation lock."
        );
      }
      if (await pathEntryExists(registryBackupPath)) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "A registry backup already exists; run detach to recover it before attaching."
        );
      }
      const registryEntry = await lstat(installedPackagePath);
      if (!registryEntry.isDirectory() && !registryEntry.isSymbolicLink()) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Installed foundation entry is neither a directory nor a symbolic link."
        );
      }
      state = {
        schemaVersion: 1,
        phase: "ATTACHING",
        consumerRoot,
        targetPackageRoot,
        registryBackupPath,
        registryEntryKind: registryEntry.isSymbolicLink()
          ? "symbolic-link"
          : "directory",
        registryPackageRoot: current.installedPackageRoot,
        packageVersion: targetManifest.version,
        gitCommit,
        gitDirty,
        attachedAt: this.#now().toISOString()
      };
      await writeLinkState(consumerRoot, state);
      if (state.registryEntryKind === "symbolic-link") {
        await symlink(
          state.registryPackageRoot,
          registryBackupPath,
          process.platform === "win32" ? "junction" : "dir"
        );
        await syncDirectory(dirname(registryBackupPath));
        await rm(installedPackagePath, { force: true });
      } else {
        await rename(installedPackagePath, registryBackupPath);
        await syncDirectory(dirname(registryBackupPath));
      }
      await syncDirectory(dirname(installedPackagePath));
      await mkdir(dirname(installedPackagePath), { recursive: true });
      await symlink(
        targetPackageRoot,
        installedPackagePath,
        process.platform === "win32" ? "junction" : "dir"
      );
      const installedPackageRoot = await realpath(installedPackagePath);
      if (installedPackageRoot !== targetPackageRoot) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Local package link does not resolve to the requested target."
        );
      }
      await syncDirectory(dirname(installedPackagePath));

      state = { ...state, phase: "LOCAL" };
      await writeLinkState(consumerRoot, state);

      const status = await this.#readStatus(consumerRoot, true);
      if (status.mode !== "LOCAL") {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          `Local attach verification failed: ${status.issues.join(" ")}`
        );
      }
      return { status, targetPackageRoot };
    } catch (error) {
      if (state === undefined) {
        throw error;
      }
      const recoveryErrors: unknown[] = [];
      try {
        await this.#restoreRegistryEntry(
          consumerRoot,
          before.dependencySpec,
          state
        );
      } catch (restoreError) {
        recoveryErrors.push(restoreError);
      }
      try {
        await removeLinkState(consumerRoot);
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
      if (recoveryErrors.length > 0) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Local attach failed and its registry state could not be fully restored.",
          {
            cause: new AggregateError(
              [error, ...recoveryErrors],
              "Attach and one or more recovery operations failed."
            )
          }
        );
      }
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Local attach failed and the registry installation was restored.",
        { cause: error }
      );
    } finally {
      await releaseLock();
    }
  }

  async detach(consumerPath: string): Promise<FoundationStatus> {
    const before = await inspectFoundationMode(consumerPath);
    if (
      before.dependencySpec === undefined ||
      !isExactVersion(before.dependencySpec)
    ) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Consumer must retain an exact ${FOUNDATION_PACKAGE_NAME} registry dependency.`
      );
    }
    const releaseLock = await acquireOperationLock(
      before.consumerRoot,
      this.#now
    );
    try {
      const current = await inspectFoundationMode(before.consumerRoot, {
        ignoreOperationLock: true
      });
      if (current.mode === "REGISTRY") {
        return current;
      }
      if (current.linkState !== undefined) {
        await writeLinkState(before.consumerRoot, {
          ...current.linkState,
          phase: "DETACHING"
        });
      }
      await this.#restoreRegistryEntry(
        before.consumerRoot,
        before.dependencySpec,
        current.linkState
      );
      await removeLinkState(before.consumerRoot);
    } finally {
      await releaseLock();
    }

    const after = await inspectFoundationMode(before.consumerRoot);
    if (after.mode !== "REGISTRY") {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        `Registry restoration failed: ${after.issues.join(" ")}`
      );
    }
    return after;
  }

  async assertRegistry(consumerPath: string): Promise<FoundationStatus> {
    const status = await inspectFoundationMode(consumerPath);
    if (status.mode !== "REGISTRY") {
      throw new FoundationError(
        "REGISTRY_MODE_REQUIRED",
        `Registry foundation mode required: ${status.issues.join(" ") || status.mode}`
      );
    }
    return status;
  }
}

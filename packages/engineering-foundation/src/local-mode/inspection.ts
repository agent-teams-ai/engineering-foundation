import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  FoundationLinkState,
  FoundationStatus
} from "./types.js";
import {
  FOUNDATION_PACKAGE_NAME,
  LOCAL_OPERATION_LOCK,
  LOCAL_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY,
  LOCAL_STATE_FILE
} from "./types.js";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly packageManager?: unknown;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
}

const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(value: unknown): PackageManifest | undefined {
  return isRecord(value) ? value : undefined;
}

function parseLinkState(value: unknown): FoundationLinkState | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !["ATTACHING", "DETACHING", "LOCAL"].includes(
      typeof value.phase === "string" ? value.phase : ""
    ) ||
    typeof value.consumerRoot !== "string" ||
    typeof value.targetPackageRoot !== "string" ||
    typeof value.registryBackupPath !== "string" ||
    !["directory", "symbolic-link"].includes(
      typeof value.registryEntryKind === "string"
        ? value.registryEntryKind
        : ""
    ) ||
    typeof value.registryPackageRoot !== "string" ||
    typeof value.packageVersion !== "string" ||
    typeof value.gitCommit !== "string" ||
    typeof value.gitDirty !== "boolean" ||
    typeof value.attachedAt !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    phase: value.phase as FoundationLinkState["phase"],
    consumerRoot: value.consumerRoot,
    targetPackageRoot: value.targetPackageRoot,
    registryBackupPath: value.registryBackupPath,
    registryEntryKind:
      value.registryEntryKind as FoundationLinkState["registryEntryKind"],
    registryPackageRoot: value.registryPackageRoot,
    packageVersion: value.packageVersion,
    gitCommit: value.gitCommit,
    gitDirty: value.gitDirty,
    attachedAt: value.attachedAt
  };
}

async function readOptionalLinkState(
  consumerRoot: string,
  issues: string[]
): Promise<FoundationLinkState | undefined> {
  const path = join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_STATE_FILE);
  try {
    const state = parseLinkState(await readJson(path));
    if (state === undefined) {
      issues.push("Local foundation state exists but is invalid.");
    }
    return state;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    issues.push("Local foundation state cannot be read.");
    return undefined;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function isExactVersion(value: string): boolean {
  return EXACT_SEMVER_PATTERN.test(value);
}

export async function inspectFoundationMode(
  consumerPath: string,
  options: { readonly ignoreOperationLock?: boolean } = {}
): Promise<FoundationStatus> {
  const consumerRoot = await realpath(resolve(consumerPath));
  const issues: string[] = [];
  const localStateDirectory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  let localStateDirectoryIsSafe = true;
  let localStateDirectoryExists = false;
  try {
    const stateEntry = await lstat(localStateDirectory);
    localStateDirectoryExists = true;
    if (
      !stateEntry.isDirectory() ||
      stateEntry.isSymbolicLink() ||
      (await realpath(localStateDirectory)) !== localStateDirectory
    ) {
      localStateDirectoryIsSafe = false;
      issues.push(
        "Local foundation state path must be a real consumer-owned directory."
      );
    }
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      localStateDirectoryIsSafe = false;
      issues.push("Local foundation state directory cannot be inspected.");
    }
  }
  const localEntries: string[] =
    localStateDirectoryExists && localStateDirectoryIsSafe
      ? await readdir(localStateDirectory)
      : [];
  if (
    options.ignoreOperationLock !== true &&
    localEntries.includes(LOCAL_OPERATION_LOCK)
  ) {
    issues.push("A foundation operation is currently active or interrupted.");
  }
  if (
    localEntries.some(
      (entry) =>
        entry.startsWith(`${LOCAL_STATE_FILE}.`) && entry.endsWith(".tmp")
    )
  ) {
    issues.push("An incomplete foundation state write requires recovery.");
  }

  let consumerManifest: PackageManifest | undefined;
  try {
    consumerManifest = parseManifest(
      await readJson(join(consumerRoot, "package.json"))
    );
  } catch {
    issues.push("Consumer package.json cannot be read.");
  }

  const dependencyCandidate =
    consumerManifest?.devDependencies?.[FOUNDATION_PACKAGE_NAME];
  const dependencySpec =
    typeof dependencyCandidate === "string" ? dependencyCandidate : undefined;

  if (dependencySpec === undefined) {
    issues.push(
      `${FOUNDATION_PACKAGE_NAME} must be declared in devDependencies.`
    );
  } else if (!isExactVersion(dependencySpec)) {
    issues.push(
      `${FOUNDATION_PACKAGE_NAME} must use an exact registry version.`
    );
  }

  if (
    typeof consumerManifest?.packageManager !== "string" ||
    !consumerManifest.packageManager.startsWith("pnpm@11.")
  ) {
    issues.push("Consumer packageManager must pin pnpm 11.");
  }

  let installedPackageRoot: string | undefined;
  let installedVersion: string | undefined;
  try {
    installedPackageRoot = await realpath(
      join(consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME)
    );
    const installedManifest = parseManifest(
      await readJson(join(installedPackageRoot, "package.json"))
    );
    if (typeof installedManifest?.version === "string") {
      installedVersion = installedManifest.version;
    } else {
      issues.push("Installed foundation package has no valid version.");
    }
  } catch {
    issues.push("Installed foundation package cannot be resolved.");
  }

  const linkState = localStateDirectoryIsSafe
    ? await readOptionalLinkState(consumerRoot, issues)
    : undefined;
  if (linkState !== undefined) {
    const expectedBackupPath = join(
      consumerRoot,
      LOCAL_STATE_DIRECTORY,
      LOCAL_REGISTRY_BACKUP
    );
    if (resolve(linkState.registryBackupPath) !== expectedBackupPath) {
      issues.push("Local state registry backup path is invalid.");
    }
    if (
      !isWithin(
        join(consumerRoot, "node_modules"),
        resolve(linkState.registryPackageRoot)
      )
    ) {
      issues.push("Local state registry package root is outside node_modules.");
    }
    try {
      const expectedBackupRoot =
        linkState.registryEntryKind === "symbolic-link"
          ? resolve(linkState.registryPackageRoot)
          : expectedBackupPath;
      if ((await realpath(expectedBackupPath)) !== expectedBackupRoot) {
        issues.push("Registry backup does not match local state.");
      }
    } catch {
      issues.push("Registry backup cannot be resolved.");
    }
    if (linkState.phase !== "LOCAL") {
      issues.push(`Local foundation operation is incomplete: ${linkState.phase}.`);
    }
    if (resolve(linkState.consumerRoot) !== consumerRoot) {
      issues.push("Local state belongs to a different consumer root.");
    }
    if (
      installedPackageRoot === undefined ||
      resolve(linkState.targetPackageRoot) !== installedPackageRoot
    ) {
      issues.push("Installed foundation path does not match local state.");
    }
    if (
      installedVersion !== undefined &&
      linkState.packageVersion !== installedVersion
    ) {
      issues.push("Installed foundation version does not match local state.");
    }
    return {
      mode: issues.length === 0 ? "LOCAL" : "INVALID",
      consumerRoot,
      ...(dependencySpec === undefined ? {} : { dependencySpec }),
      ...(installedPackageRoot === undefined ? {} : { installedPackageRoot }),
      ...(installedVersion === undefined ? {} : { installedVersion }),
      linkState,
      issues
    };
  }

  if (localStateDirectoryIsSafe) {
    try {
      await lstat(
        join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_REGISTRY_BACKUP)
      );
      issues.push("An orphan registry backup requires detach recovery.");
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        issues.push("Registry backup state cannot be inspected.");
      }
    }
  }

  if (
    installedPackageRoot !== undefined &&
    !isWithin(join(consumerRoot, "node_modules"), installedPackageRoot)
  ) {
    issues.push("Foundation resolves outside consumer node_modules without local state.");
  }
  if (
    dependencySpec !== undefined &&
    installedVersion !== undefined &&
    dependencySpec !== installedVersion
  ) {
    issues.push("Installed foundation version differs from the manifest version.");
  }

  return {
    mode: issues.length === 0 ? "REGISTRY" : "INVALID",
    consumerRoot,
    ...(dependencySpec === undefined ? {} : { dependencySpec }),
    ...(installedPackageRoot === undefined ? {} : { installedPackageRoot }),
    ...(installedVersion === undefined ? {} : { installedVersion }),
    issues
  };
}

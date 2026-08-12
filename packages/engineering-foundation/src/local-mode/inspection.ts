import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  FoundationLinkState,
  FoundationStatus,
  FoundationTransactionAwareStatus
} from "./types.js";
import {
  inspectFoundationDevOnly,
  inspectFoundationRegistryProvenance
} from "./consumer-policy.js";
import {
  FOUNDATION_PACKAGE_NAME,
  LOCAL_OPERATION_LOCK,
  LOCAL_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY,
  LOCAL_STATE_FILE
} from "./types.js";
import { installedFoundationVersion } from "../package-version.js";
import { installedFoundationBuildIdentity } from "../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { NodeFoundationTransactionSlot } from "../transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import type { FoundationTransactionStatus } from "../transaction-coordination/application/model/transaction-status.js";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function inspectLocalStateDirectory(
  consumerRoot: string,
  ignoreOperationLock: boolean,
  issues: string[]
): Promise<boolean> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  let exists = false;
  try {
    const entry = await lstat(directory);
    exists = true;
    if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(directory)) !== directory) {
      issues.push("Local foundation state path must be a real consumer-owned directory.");
      return false;
    }
  } catch (error) {
    if (!isMissing(error)) {
      issues.push("Local foundation state directory cannot be inspected.");
      return false;
    }
  }
  if (!exists) {
    return true;
  }
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (!isMissing(error)) {
      issues.push("Local foundation state directory cannot be read.");
    }
  }
  if (!ignoreOperationLock && entries.includes(LOCAL_OPERATION_LOCK)) {
    issues.push("A foundation operation is currently active or interrupted.");
  }
  if (entries.some((entry) => entry.startsWith(`${LOCAL_STATE_FILE}.`) && entry.endsWith(".tmp"))) {
    issues.push("An incomplete foundation state write requires recovery.");
  }
  return true;
}

interface InstalledFoundation {
  readonly root?: string;
  readonly version?: string;
}

async function inspectInstalledFoundation(
  consumerRoot: string,
  issues: string[]
): Promise<InstalledFoundation> {
  try {
    const root = await realpath(join(consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME));
    const manifest = await readJson(join(root, "package.json"));
    if (
      isRecord(manifest) &&
      manifest.name === FOUNDATION_PACKAGE_NAME &&
      typeof manifest.version === "string"
    ) {
      return { root, version: manifest.version };
    }
    issues.push("Installed foundation package identity or version is invalid.");
    return { root };
  } catch {
    issues.push("Installed foundation package cannot be resolved.");
    return {};
  }
}

async function inspectLinkStateConsistency(
  consumerRoot: string,
  state: FoundationLinkState,
  installed: InstalledFoundation,
  issues: string[]
): Promise<void> {
  const backupPath = join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_REGISTRY_BACKUP);
  if (resolve(state.registryBackupPath) !== backupPath) {
    issues.push("Local state registry backup path is invalid.");
  }
  if (!isWithin(join(consumerRoot, "node_modules"), resolve(state.registryPackageRoot))) {
    issues.push("Local state registry package root is outside node_modules.");
  }
  try {
    const expectedBackupRoot = state.registryEntryKind === "symbolic-link"
      ? resolve(state.registryPackageRoot)
      : backupPath;
    if ((await realpath(backupPath)) !== expectedBackupRoot) {
      issues.push("Registry backup does not match local state.");
    }
  } catch {
    issues.push("Registry backup cannot be resolved.");
  }
  if (state.phase !== "LOCAL") {
    issues.push(`Local foundation operation is incomplete: ${state.phase}.`);
  }
  if (resolve(state.consumerRoot) !== consumerRoot) {
    issues.push("Local state belongs to a different consumer root.");
  }
  if (installed.root === undefined || resolve(state.targetPackageRoot) !== installed.root) {
    issues.push("Installed foundation path does not match local state.");
  }
  if (installed.version !== undefined && state.packageVersion !== installed.version) {
    issues.push("Installed foundation version does not match local state.");
  }
}

async function inspectOrphanBackup(
  consumerRoot: string,
  issues: string[]
): Promise<void> {
  try {
    await lstat(join(consumerRoot, LOCAL_STATE_DIRECTORY, LOCAL_REGISTRY_BACKUP));
    issues.push("An orphan registry backup requires detach recovery.");
  } catch (error) {
    if (!isMissing(error)) {
      issues.push("Registry backup state cannot be inspected.");
    }
  }
}

function buildStatus(input: {
  readonly consumerRoot: string;
  readonly dependencySpec?: string;
  readonly installed: InstalledFoundation;
  readonly provenance?: { readonly lockfilePath: string; readonly packageKey: string; readonly integrity: string };
  readonly linkState?: FoundationLinkState;
  readonly transaction?: FoundationTransactionStatus;
  readonly issues: readonly string[];
}): FoundationTransactionAwareStatus {
  return {
    mode: input.issues.length === 0
      ? input.linkState === undefined ? "REGISTRY" : "LOCAL"
      : "INVALID",
    consumerRoot: input.consumerRoot,
    ...(input.dependencySpec === undefined ? {} : { dependencySpec: input.dependencySpec }),
    ...(input.installed.root === undefined ? {} : { installedPackageRoot: input.installed.root }),
    ...(input.installed.version === undefined ? {} : { installedVersion: input.installed.version }),
    ...(input.provenance === undefined
      ? {}
      : {
          lockfilePath: input.provenance.lockfilePath,
          lockfilePackageKey: input.provenance.packageKey,
          registryIntegrity: input.provenance.integrity
        }),
    ...(input.linkState === undefined ? {} : { linkState: input.linkState }),
    ...(input.transaction === undefined ? {} : { transaction: input.transaction }),
    issues: input.issues
  };
}

export async function inspectFoundationMode(
  consumerPath: string,
  options: { readonly ignoreOperationLock?: boolean } = {}
): Promise<FoundationStatus> {
  return inspectFoundationTransactionAwareMode(consumerPath, options);
}

export async function inspectFoundationTransactionAwareMode(
  consumerPath: string,
  options: { readonly ignoreOperationLock?: boolean } = {}
): Promise<FoundationTransactionAwareStatus> {
  const consumerRoot = await realpath(resolve(consumerPath));
  const issues: string[] = [];
  const localStateDirectoryIsSafe = await inspectLocalStateDirectory(
    consumerRoot,
    options.ignoreOperationLock === true,
    issues
  );
  const transaction = localStateDirectoryIsSafe
    ? await new NodeFoundationTransactionSlot({
        consumerRoot,
        installedVersion: await installedFoundationVersion(),
        installedBuildIdentity: await installedFoundationBuildIdentity()
      }).inspect()
    : { state: "idle" as const, diagnostics: [] as const };
  const transactionDiagnostic =
    transaction.state === "idle" ? undefined : transaction.diagnostics[0]?.message;
  if (transactionDiagnostic !== undefined) {
    issues.push(transactionDiagnostic);
  }
  const dependencyPolicy = await inspectFoundationDevOnly(consumerRoot);
  issues.push(...dependencyPolicy.issues);
  const dependencySpec = dependencyPolicy.dependencySpec;
  const provenance = await inspectFoundationRegistryProvenance(
    consumerRoot,
    dependencySpec
  );
  issues.push(...provenance.issues);
  const installed = await inspectInstalledFoundation(consumerRoot, issues);

  const linkState = localStateDirectoryIsSafe
    ? await readOptionalLinkState(consumerRoot, issues)
    : undefined;
  if (linkState !== undefined) {
    await inspectLinkStateConsistency(consumerRoot, linkState, installed, issues);
    return buildStatus({
      consumerRoot,
      ...(dependencySpec === undefined ? {} : { dependencySpec }),
      installed,
      ...(provenance.provenance === undefined ? {} : { provenance: provenance.provenance }),
      linkState,
      ...(transaction.state === "idle" ? {} : { transaction }),
      issues
    });
  }

  if (localStateDirectoryIsSafe) {
    await inspectOrphanBackup(consumerRoot, issues);
  }

  if (installed.root !== undefined && !isWithin(join(consumerRoot, "node_modules"), installed.root)) {
    issues.push("Foundation resolves outside consumer node_modules without local state.");
  }
  if (
    dependencySpec !== undefined &&
    installed.version !== undefined &&
    dependencySpec !== installed.version
  ) {
    issues.push("Installed foundation version differs from the manifest version.");
  }

  return buildStatus({
    consumerRoot,
    ...(dependencySpec === undefined ? {} : { dependencySpec }),
    installed,
    ...(provenance.provenance === undefined ? {} : { provenance: provenance.provenance }),
    ...(transaction.state === "idle" ? {} : { transaction }),
    issues
  });
}

export {
  inspectFoundationDevOnly,
  inspectFoundationRegistryProvenance
} from "./consumer-policy.js";
export { isExactVersion } from "../semantic-version.js";

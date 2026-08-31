import { posix } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../../capability-runtime.js";
import {
  assertNotCancelled,
  loadStrictYamlFile
} from "../../../../../strict-yaml.js";
import type { WorkspaceInventory } from "../../../../../workspace-inventory/application/model/workspace-inventory.js";
import type {
  InspectSourceWorkspaceTopologyInput,
  SourceWorkspaceInventorySnapshotReader
} from "../../../application/ports/source-workspace-topology-inspector.js";
import {
  discoverSourceWorkspacePaths,
  type DiscoveredSourceWorkspacePaths,
  type SourceWorkspaceDiscoveryHooks,
  type SourceWorkspaceDiscoveryLimits
} from "./selected-package-source-discovery.js";
import {
  captureStableRepositoryPath,
  type SourceWorkspaceFileSystem,
  type StableRepositoryPath
} from "./source-workspace-filesystem.js";
import { inspectUniqueRoots } from "./source-workspace-root-snapshot.js";

export type WorkspaceManifestLoader = typeof loadStrictYamlFile;

interface CapturePnpmSourceWorkspaceSnapshotInput {
  readonly fileSystem: SourceWorkspaceFileSystem;
  readonly hooks?: SourceWorkspaceDiscoveryHooks;
  readonly input: InspectSourceWorkspaceTopologyInput;
  readonly inventoryReader: SourceWorkspaceInventorySnapshotReader;
  readonly limits: SourceWorkspaceDiscoveryLimits;
  readonly workspaceManifestLoader?: WorkspaceManifestLoader;
}

export interface PnpmSourceWorkspaceSnapshot {
  readonly canonicalConsumerRoot: string;
  readonly configuredPackageRoots: readonly StableRepositoryPath[];
  readonly consumerRootSnapshot: StableRepositoryPath;
  readonly discovered: DiscoveredSourceWorkspacePaths;
  readonly inventory: WorkspaceInventory;
  readonly selectedManifestPaths: readonly string[];
  readonly selectedPackages: WorkspaceInventory["packages"];
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "source-workspace-topology",
    retryable: false
  });
}

function portableCanonicalIdentity(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function packageRootForManifest(manifestPath: string): string {
  return manifestPath === "package.json" ? "." : posix.dirname(manifestPath);
}

function manifestSelectedByPackageRoot(
  manifestPath: string,
  packageRoot: string
): boolean {
  const manifestRoot = packageRootForManifest(manifestPath);
  return (
    portableCanonicalIdentity(manifestRoot) ===
      portableCanonicalIdentity(packageRoot) ||
    portableCanonicalIdentity(posix.dirname(manifestRoot)) ===
      portableCanonicalIdentity(packageRoot)
  );
}

function assertPackageRootsContainPackages(
  packageRoots: readonly string[],
  manifestPaths: readonly string[]
): void {
  for (const packageRoot of packageRoots) {
    const identity = portableCanonicalIdentity(packageRoot);
    const hasManifest = manifestPaths.some((manifestPath) => {
      const manifestRoot = portableCanonicalIdentity(
        packageRootForManifest(manifestPath)
      );
      return (
        identity === "." ||
        manifestRoot === identity ||
        manifestRoot.startsWith(`${identity}/`)
      );
    });
    if (!hasManifest) {
      inputError(
        "PACKAGE_ROOT_EMPTY",
        `Schema v2 package root contains no package manifests: ${packageRoot}.`
      );
    }
  }
}

function assertPortableDiscoveryAgreement(
  workspaceManifestPaths: readonly string[],
  discovered: DiscoveredSourceWorkspacePaths
): void {
  const discoveredDirectories = new Map(
    discovered.directorySnapshots.map(({ repositoryPath }) => [
      portableCanonicalIdentity(repositoryPath),
      repositoryPath
    ])
  );
  for (const manifestPath of workspaceManifestPaths) {
    const manifestRoot = packageRootForManifest(manifestPath);
    const discoveredDirectory = discoveredDirectories.get(
      portableCanonicalIdentity(manifestRoot)
    );
    if (
      discoveredDirectory !== undefined &&
      discoveredDirectory !== manifestRoot
    ) {
      inputError(
        "PACKAGE_PATH_CASE_COLLISION",
        `Workspace manifest and source directory paths differ only by portable identity: ${manifestRoot} and ${discoveredDirectory}.`
      );
    }
  }
}

export async function capturePnpmSourceWorkspaceSnapshot(
  snapshotInput: CapturePnpmSourceWorkspaceSnapshotInput
): Promise<PnpmSourceWorkspaceSnapshot> {
  const { fileSystem, input } = snapshotInput;
  assertNotCancelled(input.signal);
  const workspaceManifest = await (
    snapshotInput.workspaceManifestLoader ?? loadStrictYamlFile
  )(
    input.consumerRoot,
    input.workspaceManifestPath,
    "source-workspace-topology",
    input.signal
  );
  const canonicalConsumerRoot = await fileSystem
    .realpath(input.consumerRoot)
    .catch(() => {
      assertNotCancelled(input.signal);
      return inputError(
        "CONSUMER_ROOT_UNAVAILABLE",
        "Consumer root must be an existing accessible directory."
      );
    });
  assertNotCancelled(input.signal);
  const consumerRootSnapshot = await captureStableRepositoryPath(
    canonicalConsumerRoot,
    ".",
    "directory",
    fileSystem,
    input.signal
  );
  const configuredPackageRoots = await inspectUniqueRoots({
    canonicalConsumerRoot,
    expectedKind: "directory",
    label: "Configured package roots",
    operations: fileSystem,
    roots: input.packageRoots,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    symbolicLinkCode: "PACKAGE_ROOT_SYMLINK_PROHIBITED"
  });
  const discovered = await discoverSourceWorkspacePaths(canonicalConsumerRoot, {
    repositoryRoots: input.packageRoots,
    fileSystem,
    limits: snapshotInput.limits,
    ...(snapshotInput.hooks === undefined ? {} : { hooks: snapshotInput.hooks }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const workspaceManifestPaths = await snapshotInput.inventoryReader
    .discoverManifestPathsFromManifest(
      canonicalConsumerRoot,
      workspaceManifest,
      input.signal
    );
  assertPortableDiscoveryAgreement(workspaceManifestPaths, discovered);
  const unclassifiedWorkspaceManifest = workspaceManifestPaths.find(
    (manifestPath) =>
      manifestPath !== "package.json" &&
      !input.packageRoots.some((packageRoot) =>
        manifestSelectedByPackageRoot(manifestPath, packageRoot)
      )
  );
  if (unclassifiedWorkspaceManifest !== undefined) {
    inputError(
      "WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS",
      `pnpm workspace package is outside the closed schema v2 packageRoots contract: ${unclassifiedWorkspaceManifest}.`
    );
  }
  const selectedManifestPaths = Object.freeze(
    discovered.manifestPaths.filter((manifestPath) =>
      input.packageRoots.some((packageRoot) =>
        manifestSelectedByPackageRoot(manifestPath, packageRoot)
      )
    )
  );
  assertPackageRootsContainPackages(input.packageRoots, selectedManifestPaths);
  const manifestPaths = Object.freeze(
    [...new Set(["package.json", ...selectedManifestPaths])].toSorted(
      compareBinaryStrings
    )
  );
  const inventory = await snapshotInput.inventoryReader.readFromManifestPaths(
    canonicalConsumerRoot,
    workspaceManifest,
    manifestPaths,
    input.signal
  );
  const selectedManifestSet = new Set(selectedManifestPaths);
  const selectedPackages = inventory.packages.filter((workspacePackage) =>
    selectedManifestSet.has(workspacePackage.manifestPath)
  );
  return Object.freeze({
    canonicalConsumerRoot,
    configuredPackageRoots,
    consumerRootSnapshot,
    discovered,
    inventory,
    selectedManifestPaths,
    selectedPackages
  });
}

import { join, posix } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError,assertNotCancelled } from "../../../../../features/validation-reporting/api.js";
import { loadStrictYamlFile } from "../../../../../features/configuration-input/node.js";
import type { WorkspaceInventory } from "../../../application/model/workspace-inventory.js";
import { portableRepositoryPathIdentity } from "../../../application/model/repository-path.js";
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
  readonly packageTypeScopes: readonly {
    readonly moduleType: "commonjs" | "module";
    readonly rootPath: string;
  }[];
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

async function readPackageTypeScopes(
  canonicalConsumerRoot: string,
  manifestPaths: readonly string[],
  fileSystem: SourceWorkspaceFileSystem,
  signal?: AbortSignal
): Promise<readonly { readonly moduleType: "commonjs" | "module"; readonly rootPath: string }[]> {
  const scopes = [] as { moduleType: "commonjs" | "module"; rootPath: string }[];
  for (const manifestPath of manifestPaths) {
    assertNotCancelled(signal);
    let value: unknown;
    try {
      const bytes = await fileSystem.readContainedFile({
        candidate: join(canonicalConsumerRoot, ...manifestPath.split("/")),
        maxBytes: 2 * 1024 * 1024,
        root: canonicalConsumerRoot
      });
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      assertNotCancelled(signal);
      inputError(
        "PACKAGE_MANIFEST_INVALID",
        `Nested package scope is unavailable or invalid: ${manifestPath}.`
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      inputError(
        "PACKAGE_MANIFEST_INVALID",
        `Nested package scope must contain an object: ${manifestPath}.`
      );
    }
    scopes.push({
      moduleType: (value as Record<string, unknown>)["type"] === "module"
        ? "module"
        : "commonjs",
      rootPath: packageRootForManifest(manifestPath)
    });
  }
  return Object.freeze(scopes.toSorted((left, right) =>
    compareBinaryStrings(left.rootPath, right.rootPath)
  ));
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
    portableRepositoryPathIdentity(manifestRoot) ===
      portableRepositoryPathIdentity(packageRoot) ||
    portableRepositoryPathIdentity(posix.dirname(manifestRoot)) ===
      portableRepositoryPathIdentity(packageRoot)
  );
}

function assertPackageRootsContainPackages(
  packageRoots: readonly string[],
  manifestPaths: readonly string[]
): void {
  for (const packageRoot of packageRoots) {
    const identity = portableRepositoryPathIdentity(packageRoot);
    const hasManifest = manifestPaths.some((manifestPath) => {
      const manifestRoot = portableRepositoryPathIdentity(
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
      portableRepositoryPathIdentity(repositoryPath),
      repositoryPath
    ])
  );
  for (const manifestPath of workspaceManifestPaths) {
    const manifestRoot = packageRootForManifest(manifestPath);
    const discoveredDirectory = discoveredDirectories.get(
      portableRepositoryPathIdentity(manifestRoot)
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
  let workspaceManifestPaths: readonly string[];
  try {
    workspaceManifestPaths = await snapshotInput.inventoryReader
      .discoverManifestPathsFromManifest(
        canonicalConsumerRoot,
        workspaceManifest,
        input.signal
      );
  } catch (error) {
    if (
      error instanceof CapabilityInputError &&
      error.problem.code === "PACKAGE_PATH_CASE_COLLISION"
    ) {
      // Workspace glob discovery necessarily observes non-package directories.
      // Give the source topology owner the opportunity to classify an alias in
      // the configured source closure before retaining the package diagnostic.
      // This keeps logical repository identities separate by evidence role.
      await discoverSourceWorkspacePaths(canonicalConsumerRoot, {
        repositoryRoots: input.packageRoots,
        governedRoots: input.governedRoots,
        boundaryRoots: input.boundaryRoots.map(({ path }) => path),
        fileSystem,
        limits: snapshotInput.limits,
        ...(snapshotInput.hooks === undefined ? {} : { hooks: snapshotInput.hooks }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
    }
    throw error;
  }
  const selectedWorkspacePackageRoots = workspaceManifestPaths
    .filter(
      (manifestPath) =>
        manifestPath !== "package.json" &&
        input.packageRoots.some((packageRoot) =>
          manifestSelectedByPackageRoot(manifestPath, packageRoot)
        )
    )
    .map(packageRootForManifest);
  const discovered = await discoverSourceWorkspacePaths(canonicalConsumerRoot, {
    repositoryRoots: input.packageRoots,
    governedRoots: input.governedRoots,
    boundaryRoots: input.boundaryRoots.map(({ path }) => path),
    selectedPackageRoots: selectedWorkspacePackageRoots,
    fileSystem,
    limits: snapshotInput.limits,
    ...(snapshotInput.hooks === undefined ? {} : { hooks: snapshotInput.hooks }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
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
  const packageTypeScopes = await readPackageTypeScopes(
    canonicalConsumerRoot,
    discovered.manifestPaths,
    fileSystem,
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
    packageTypeScopes,
    selectedManifestPaths,
    selectedPackages
  });
}

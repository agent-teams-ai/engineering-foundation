import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import {
  sourceTopologyInputError as inputError,
  type SourceWorkspaceFileReader,
  type SourceWorkspaceManifestLoader
} from "../../../api.js";
import type { SourceWorkspaceTopology } from "../../../application/model/source-workspace-topology.js";
import type {
  InspectSourceWorkspaceTopologyInput,
  SourceBoundaryRootDescription,
  SourceWorkspaceInventorySnapshotReader,
  SourceWorkspaceTopologyInspector
} from "../../../application/ports/source-workspace-topology-inspector.js";
import {
  buildSelectedPackageSourceTopology,
  rootOutsideSelectedPackages,
  sourceWorkspaceDiscoveryLimits,
  type SourceWorkspaceDiscoveryHooks,
  type SourceWorkspaceDiscoveryLimits
} from "./selected-package-source-discovery.js";
import { readGovernedSourceFiles } from "./selected-package-source-snapshot-reader.js";
import {
  capturePnpmSourceWorkspaceSnapshot
} from "./pnpm-source-workspace-snapshot.js";
import {
  createSourceWorkspaceFileSystem,
  type SourceWorkspaceFileSystem
} from "./source-workspace-filesystem.js";
import {
  inspectUniqueRoots,
  revalidateRoots
} from "./source-workspace-root-snapshot.js";

export interface PnpmSourceWorkspaceTopologyInspectorDependencies {
  readonly fileReader: SourceWorkspaceFileReader;
  readonly fileSystem?: Partial<SourceWorkspaceFileSystem>;
  readonly hooks?: SourceWorkspaceDiscoveryHooks;
  readonly inventoryReader: SourceWorkspaceInventorySnapshotReader;
  readonly limits?: Partial<SourceWorkspaceDiscoveryLimits>;
  readonly workspaceManifestLoader: SourceWorkspaceManifestLoader;
}

function boundaryRootPaths(
  roots: readonly SourceBoundaryRootDescription[]
): readonly string[] {
  return roots
    .toSorted(
      (left, right) =>
        compareBinaryStrings(left.path, right.path) ||
        compareBinaryStrings(left.boundaryId, right.boundaryId)
    )
    .map((root) => root.path);
}

export class PnpmSourceWorkspaceTopologyInspector
  implements SourceWorkspaceTopologyInspector
{
  readonly #dependencies: PnpmSourceWorkspaceTopologyInspectorDependencies;
  readonly #fileSystem: SourceWorkspaceFileSystem;
  readonly #limits: SourceWorkspaceDiscoveryLimits;

  constructor(dependencies: PnpmSourceWorkspaceTopologyInspectorDependencies) {
    this.#dependencies = dependencies;
    this.#fileSystem = createSourceWorkspaceFileSystem(dependencies.fileReader, dependencies.fileSystem);
    this.#limits = sourceWorkspaceDiscoveryLimits(dependencies.limits);
  }

  async inspect(
    input: InspectSourceWorkspaceTopologyInput
  ): Promise<SourceWorkspaceTopology> {
    const {
      canonicalConsumerRoot,
      configuredPackageRoots,
      consumerRootSnapshot,
      discovered,
      inventory,
      packageTypeScopes,
      selectedManifestPaths,
      selectedPackages
    } = await capturePnpmSourceWorkspaceSnapshot({
      fileSystem: this.#fileSystem,
      input,
      inventoryReader: this.#dependencies.inventoryReader,
      limits: this.#limits,
      ...(this.#dependencies.hooks === undefined
        ? {}
        : { hooks: this.#dependencies.hooks }),
      workspaceManifestLoader: this.#dependencies.workspaceManifestLoader
    });
    const outsideRoot = [
      ...input.governedRoots,
      ...input.boundaryRoots.map(({ path }) => path)
    ]
      .toSorted(compareBinaryStrings)
      .find((root) =>
        rootOutsideSelectedPackages(
          root,
          selectedPackages,
          selectedManifestPaths
        )
      );
    if (outsideRoot !== undefined) {
      inputError(
        "SOURCE_ROOT_OUTSIDE_WORKSPACE",
        `Governed or architecture boundary root is outside the schema v2 packageRoots contract: ${outsideRoot}.`
      );
    }
    const packageRoots = await inspectUniqueRoots({
      canonicalConsumerRoot,
      expectedKind: "directory",
      label: "Workspace package roots",
      operations: this.#fileSystem,
      roots: selectedPackages.map((workspacePackage) => workspacePackage.rootPath),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const governedRoots = await inspectUniqueRoots({
      canonicalConsumerRoot,
      expectedKind: "directory",
      label: "Governed roots",
      operations: this.#fileSystem,
      roots: input.governedRoots,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const boundaryRoots = await inspectUniqueRoots({
      canonicalConsumerRoot,
      expectedKind: "source",
      label: "Architecture boundary roots",
      operations: this.#fileSystem,
      roots: boundaryRootPaths(input.boundaryRoots),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const symbolicLink = discovered.symbolicLinkPaths[0];
    if (symbolicLink !== undefined) {
      inputError(
        "SOURCE_SYMLINK_PROHIBITED",
        `Selected workspace source cannot contain symbolic links: ${symbolicLink}.`
      );
    }
    const packageRootIdentities = new Map(
      packageRoots.map((root) => [
        root.repositoryPath,
        Object.freeze({
          device: String(root.canonicalMetadata.dev),
          inode: String(root.canonicalMetadata.ino)
        })
      ])
    );
    const packages = buildSelectedPackageSourceTopology(
      selectedPackages,
      discovered.sourcePaths,
      selectedManifestPaths
    ).map((workspacePackage) => Object.freeze({
      ...workspacePackage,
      filesystemIdentity: packageRootIdentities.get(workspacePackage.rootPath) ??
        inputError(
          "SOURCE_FILESYSTEM_CHANGED",
          `Workspace package root identity is missing: ${workspacePackage.rootPath}.`
        )
    }));
    const unownedSourcePath = discovered.sourcePaths.find((path) =>
      rootOutsideSelectedPackages(path, selectedPackages, selectedManifestPaths)
    );
    if (unownedSourcePath !== undefined) {
      inputError(
        "SOURCE_OUTSIDE_PACKAGE",
        `Source below a configured package root belongs to no package: ${unownedSourcePath}.`
      );
    }
    const selectedSourcePaths = packages
      .flatMap((workspacePackage) => workspacePackage.sourcePaths)
      .toSorted(compareBinaryStrings);
    const sourceFiles = await readGovernedSourceFiles(
      canonicalConsumerRoot,
      selectedSourcePaths,
      input.governedRoots,
      {
        fileSystem: this.#fileSystem,
        limits: this.#limits,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }
    );
    await revalidateRoots({
      canonicalConsumerRoot,
      operations: this.#fileSystem,
      roots: [
        consumerRootSnapshot,
        ...discovered.directorySnapshots,
        ...configuredPackageRoots,
        ...packageRoots,
        ...governedRoots,
        ...boundaryRoots
      ],
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return Object.freeze({
      canonicalConsumerRoot,
      consumerRootIdentity: Object.freeze({
        device: String(consumerRootSnapshot.canonicalMetadata.dev),
        inode: String(consumerRootSnapshot.canonicalMetadata.ino)
      }),
      inventory,
      packageTypeScopes,
      packages,
      sourceFiles
    });
  }
}

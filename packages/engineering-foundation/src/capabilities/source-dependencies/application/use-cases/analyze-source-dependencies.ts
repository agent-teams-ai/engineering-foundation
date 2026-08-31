import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { assertNotCancelled } from "../../../../cancellation.js";
import { CapabilityInputError } from "../../../../capability-runtime.js";
import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type { SourceFileSnapshot } from "../../../../source-inventory/application/model/source-file-snapshot.js";
import type { SourceTreeReader } from "../../../../source-inventory/application/ports/source-tree-reader.js";
import type {
  WorkspaceInventory,
  WorkspacePackage
} from "../../../../workspace-inventory/application/model/workspace-inventory.js";
import type { WorkspaceInventoryReader } from "../../../../workspace-inventory/application/ports/workspace-inventory-reader.js";
import {
  exactAvailablePackageExport,
  exactPackageExportTargetPaths
} from "../../../../workspace-inventory/application/policies/package-export-matcher.js";
import type {
  ArchitectureBoundaryPolicy,
  ClassifiedSourceFile,
  ObservedSourceGraph,
  SourceArchitecturePolicy
} from "../model/source-workspace.js";
import {
  normalizeRepositoryPath,
  pathIsInside,
  portablePathIsInside,
  portableRepositoryPathIdentity
} from "../model/repository-path.js";
import type { SourceDependencyParser } from "../ports/source-dependency-parser.js";
import type { SourceDependencyResolver } from "../ports/source-dependency-resolver.js";
import type { SourceWorkspaceTopologyInspector } from "../ports/source-workspace-topology-inspector.js";
import { evaluateSourceDependencies } from "../policies/evaluate-source-dependencies.js";
import { evaluateSourceWorkspaceCoverage } from "../policies/evaluate-source-workspace-coverage.js";
import { buildObservedSourceGraph } from "./build-observed-source-graph.js";

export interface AnalyzeSourceDependenciesInput {
  readonly consumerRoot: string;
  readonly policy: SourceArchitecturePolicy;
  readonly signal?: AbortSignal;
}

export interface AnalyzeSourceDependenciesDependencies {
  readonly inventoryReader: WorkspaceInventoryReader;
  readonly parser: SourceDependencyParser;
  readonly resolver: SourceDependencyResolver;
  readonly sourceReader: SourceTreeReader;
  readonly topologyInspector: SourceWorkspaceTopologyInspector;
}

function pathInside(path: string, root: string, portable: boolean): boolean {
  return portable ? portablePathIsInside(path, root) : pathIsInside(path, root);
}

interface BoundaryMatch {
  readonly boundary: ArchitectureBoundaryPolicy;
  readonly specificity: number;
}

function matchingBoundarySpecificity(
  path: string,
  boundary: ArchitectureBoundaryPolicy,
  portable: boolean
): number | undefined {
  const matchingRoots = boundary.roots
    .filter((root) => pathInside(path, root, portable))
    .map((root) => normalizeRepositoryPath(root).length);
  return matchingRoots.length === 0 ? undefined : Math.max(...matchingRoots);
}

function selectBoundary(
  file: SourceFileSnapshot,
  policy: SourceArchitecturePolicy
): ArchitectureBoundaryPolicy | undefined {
  const matches: BoundaryMatch[] = [];
  for (const boundary of policy.boundaries) {
    const specificity = matchingBoundarySpecificity(
      file.path,
      boundary,
      policy.schemaVersion === 2
    );
    if (specificity !== undefined) {
      matches.push({ boundary, specificity });
    }
  }
  if (matches.length === 0) {
    return undefined;
  }

  if (policy.schemaVersion === 2 && matches.length > 1) {
    const candidateIds = matches
      .map((match) => match.boundary.id)
      .toSorted(compareBinaryStrings)
      .join(", ");
    throw new CapabilityInputError({
      code: "SOURCE_BOUNDARY_AMBIGUOUS",
      message: `Schema v2 source file matches multiple architecture boundaries: ${file.path} (${candidateIds}).`,
      phase: "source-boundary-classification",
      retryable: false
    });
  }

  const highestSpecificity = Math.max(...matches.map((match) => match.specificity));
  const mostSpecific = matches
    .filter((match) => match.specificity === highestSpecificity)
    .toSorted((left, right) => compareBinaryStrings(left.boundary.id, right.boundary.id));

  if (mostSpecific.length > 1) {
    const candidateIds = mostSpecific.map((match) => match.boundary.id).join(", ");
    throw new CapabilityInputError({
      code: "SOURCE_BOUNDARY_AMBIGUOUS",
      message: `Source file matches multiple equally specific architecture boundaries: ${file.path} (${candidateIds}).`,
      phase: "source-boundary-classification",
      retryable: false
    });
  }

  return mostSpecific[0]?.boundary;
}

function containingPackage(
  path: string,
  packages: readonly WorkspacePackage[],
  portable: boolean
): WorkspacePackage | undefined {
  return packages
    .filter((workspacePackage) =>
      workspacePackage.rootPath === "."
        ? true
        : pathInside(path, workspacePackage.rootPath, portable)
    )
    .toSorted(
      (left, right) =>
        right.rootPath.length - left.rootPath.length ||
        compareBinaryStrings(left.name, right.name)
    )[0];
}

function classifyFiles(
  files: readonly SourceFileSnapshot[],
  policy: SourceArchitecturePolicy,
  packages: readonly WorkspacePackage[],
  parser: SourceDependencyParser,
  signal: AbortSignal | undefined
): readonly ClassifiedSourceFile[] {
  const classified: ClassifiedSourceFile[] = [];
  for (const file of files) {
    assertNotCancelled(signal);
    const normalizedFile: SourceFileSnapshot = {
      ...file,
      path: normalizeRepositoryPath(file.path)
    };
    const boundary = selectBoundary(normalizedFile, policy);
    const workspacePackage = containingPackage(
      normalizedFile.path,
      packages,
      policy.schemaVersion === 2
    );
    if (boundary === undefined || workspacePackage === undefined) {
      continue;
    }
    classified.push({
      ...normalizedFile,
      boundary,
      workspacePackage,
      parsed: parser.parse(normalizedFile)
    });
  }
  return classified;
}

function assertInventoryUsable(
  packages: readonly WorkspacePackage[]
): void {
  const names = new Set<string>();
  for (const workspacePackage of packages) {
    if (workspacePackage.name.startsWith("<unnamed:") || names.has(workspacePackage.name)) {
      throw new CapabilityInputError({
        code: "WORKSPACE_IDENTITY_INVALID",
        message: "Source architecture requires unique named workspace packages.",
        phase: "source-workspace-inventory",
        retryable: false
      });
    }
    names.add(workspacePackage.name);
  }
}

function buildPackageExportBoundaries(
  policy: SourceArchitecturePolicy,
  inventory: WorkspaceInventory,
  graph: ObservedSourceGraph
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  if (policy.schemaVersion !== 2) {
    return new Map();
  }
  const packageNamesByBoundary = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const names = packageNamesByBoundary.get(node.boundaryId) ?? new Set<string>();
    names.add(node.workspacePackageName);
    packageNamesByBoundary.set(node.boundaryId, names);
  }
  const nodesByPortablePath = new Map(
    graph.nodes.map((node) => [portableRepositoryPathIdentity(node.path), node])
  );
  const mutable = new Map<string, Map<string, string>>();
  for (const boundary of policy.boundaries) {
    if (boundary.packageExports.length === 0) {
      continue;
    }
    const names = [...(packageNamesByBoundary.get(boundary.id) ?? [])];
    if (names.length !== 1) {
      throw new CapabilityInputError({
        code: "SOURCE_EXPORT_BOUNDARY_INVALID",
        message: `Package export claims require one exact package owner: ${boundary.id}.`,
        phase: "source-boundary-classification",
        retryable: false
      });
    }
    const packageName = names[0];
    const workspacePackage = inventory.packages.find(({ name }) => name === packageName);
    if (packageName === undefined || workspacePackage === undefined) {
      throw new CapabilityInputError({ code: "SOURCE_EXPORT_BOUNDARY_INVALID", message: `Package export claim has no workspace package owner: ${boundary.id}.`, phase: "source-boundary-classification", retryable: false });
    }
    const bySubpath = mutable.get(packageName) ?? new Map<string, string>();
    for (const subpath of boundary.packageExports) {
      if (!exactAvailablePackageExport(workspacePackage.exportSurface.entries, subpath)) {
        throw new CapabilityInputError({ code: "SOURCE_EXPORT_BOUNDARY_INVALID", message: `Package export claim is stale or not exported: ${packageName}:${subpath}.`, phase: "source-boundary-classification", retryable: false });
      }
      if (bySubpath.has(subpath)) {
        throw new CapabilityInputError({ code: "SOURCE_EXPORT_BOUNDARY_INVALID", message: `Package export has duplicate boundary ownership: ${packageName}:${subpath}.`, phase: "source-boundary-classification", retryable: false });
      }
      for (const target of exactPackageExportTargetPaths(
        workspacePackage.exportSurface.entries,
        subpath
      )) {
        const targetPath = normalizeRepositoryPath(
          `${workspacePackage.rootPath}/${target.slice(2)}`
        );
        const observedOwner = nodesByPortablePath.get(
          portableRepositoryPathIdentity(targetPath)
        );
        if (observedOwner !== undefined && observedOwner.boundaryId !== boundary.id) {
          throw new CapabilityInputError({ code: "SOURCE_EXPORT_BOUNDARY_INVALID", message: `Package export claim contradicts observed source ownership: ${packageName}:${subpath}.`, phase: "source-boundary-classification", retryable: false });
        }
      }
      bySubpath.set(subpath, boundary.id);
    }
    mutable.set(packageName, bySubpath);
  }
  return new Map([...mutable].map(([name, entries]) => [name, new Map(entries)]));
}

export async function analyzeSourceDependencies(
  input: AnalyzeSourceDependenciesInput,
  dependencies: AnalyzeSourceDependenciesDependencies
): Promise<readonly FoundationDiagnostic[]> {
  if (input.policy.schemaVersion === 2) {
    const topology = await dependencies.topologyInspector.inspect({
      consumerRoot: input.consumerRoot,
      workspaceManifestPath: input.policy.workspaceManifestPath,
      packageRoots: input.policy.packageRoots,
      governedRoots: input.policy.governedRoots,
      boundaryRoots: input.policy.boundaries.flatMap((boundary) =>
        boundary.roots.map((path) => ({ boundaryId: boundary.id, path }))
      ),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const { inventory, sourceFiles } = topology;
    assertInventoryUsable(inventory.packages);
    const coverageDiagnostics = evaluateSourceWorkspaceCoverage(
      input.policy,
      topology
    );
    const classifiedFiles = classifyFiles(
      sourceFiles,
      input.policy,
      inventory.packages,
      dependencies.parser,
      input.signal
    );
    const graph = buildObservedSourceGraph({
      consumerRoot: topology.canonicalConsumerRoot,
      consumerRootIdentity: topology.consumerRootIdentity,
      enforceWorkspaceBindings: true,
      inventory,
      governedWorkspacePackageManifestPaths: new Set(
        topology.packages.map(({ manifestPath }) => manifestPath)
      ),
      allSourceFiles: sourceFiles,
      classifiedFiles,
      resolver: dependencies.resolver,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return [
      ...coverageDiagnostics,
      ...evaluateSourceDependencies({
        policy: input.policy,
        graph,
        packageExportBoundaries: buildPackageExportBoundaries(input.policy, inventory, graph)
      })
    ];
  }
  const [inventory, sourceFiles] = await Promise.all([
    dependencies.inventoryReader.read(
      input.consumerRoot,
      input.policy.workspaceManifestPath,
      input.signal
    ),
    dependencies.sourceReader.read(
      input.consumerRoot,
      input.policy.governedRoots,
      input.signal
    )
  ]);
  assertInventoryUsable(inventory.packages);
  const classifiedFiles = classifyFiles(
    sourceFiles,
    input.policy,
    inventory.packages,
    dependencies.parser,
    input.signal
  );
  const graph = buildObservedSourceGraph({
    consumerRoot: input.consumerRoot,
    inventory,
    allSourceFiles: sourceFiles,
    classifiedFiles,
    resolver: dependencies.resolver,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return evaluateSourceDependencies({
    policy: input.policy,
    graph
  });
}

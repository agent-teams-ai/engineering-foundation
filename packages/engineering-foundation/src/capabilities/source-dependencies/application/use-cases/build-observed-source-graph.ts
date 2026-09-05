import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { assertNotCancelled,CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import type { SourceFileSnapshot } from "../model/source-file-snapshot.js";
import type { WorkspaceInventory } from "../../../../workspace-inventory/api.js";
import {
  normalizeRepositoryPath
} from "../model/repository-path.js";
import type {
  ClassifiedSourceFile,
  ObservedSourceDependencyEdge,
  ObservedSourceDependencyResolution,
  ObservedSourceGraph,
  ObservedSourceNode,
  ObservedUnresolvedRuntimeReference,
  ResolvedSourceDependency,
  SourceDependencyEdgeMode,
  SourceDependencyKind
} from "../model/source-workspace.js";
import type { SourceDependencyResolver } from "../ports/source-dependency-resolver.js";

export interface BuildObservedSourceGraphInput {
  readonly consumerRoot?: string;
  readonly consumerRootIdentity?: {
    readonly device: string;
    readonly inode: string;
  };
  readonly enforceWorkspaceBindings?: boolean;
  readonly inventory: WorkspaceInventory;
  readonly packageTypeScopes?: readonly {
    readonly moduleType: "commonjs" | "module";
    readonly rootPath: string;
  }[];
  readonly governedWorkspacePackageManifestPaths?: ReadonlySet<string>;
  readonly allSourceFiles: readonly SourceFileSnapshot[];
  readonly classifiedFiles: readonly ClassifiedSourceFile[];
  readonly resolver: SourceDependencyResolver;
  readonly signal?: AbortSignal;
  readonly workspacePackageRootIdentities?: ReadonlyMap<string, {
    readonly device: string;
    readonly inode: string;
  }>;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "observed-source-graph",
    retryable: false
  });
}

function edgeMode(kind: SourceDependencyKind): SourceDependencyEdgeMode {
  switch (kind) {
    case "export-type":
    case "import-equals-type":
    case "static-type":
    case "type-query":
      return "type-only";
    case "commonjs":
    case "dynamic":
    case "export":
    case "import-equals":
    case "static":
      return "runtime";
  }
}

function normalizedSourcePaths(
  files: readonly SourceFileSnapshot[]
): readonly string[] {
  const paths = files.map((file) => normalizeRepositoryPath(file.path)).toSorted();
  for (let index = 1; index < paths.length; index += 1) {
    if (paths[index] === paths[index - 1]) {
      inputError(
        "OBSERVED_SOURCE_GRAPH_DUPLICATE_PATH",
        `Observed source paths normalize to the same repository path: ${paths[index]}.`
      );
    }
  }
  return Object.freeze(paths);
}

function normalizedClassifiedFile(file: ClassifiedSourceFile): ClassifiedSourceFile {
  return {
    ...file,
    path: normalizeRepositoryPath(file.path)
  };
}

function compareNodes(left: ObservedSourceNode, right: ObservedSourceNode): number {
  return compareBinaryStrings(left.path, right.path);
}

function resolutionKey(resolution: ObservedSourceDependencyResolution): string {
  switch (resolution.kind) {
    case "builtin":
      return `${resolution.kind}:${resolution.specifier}`;
    case "external-package":
      return `${resolution.kind}:${resolution.packageName}:${resolution.declaration}`;
    case "local-file":
      return `${resolution.kind}:${resolution.path}:${resolution.targetBoundaryId ?? ""}`;
    case "generated-output-candidate":
      return `${resolution.kind}:${resolution.path}:${resolution.workspacePackageName}`;
    case "self-workspace-package":
      return `${resolution.kind}:${resolution.workspacePackageName}:${resolution.subpath}`;
    case "unsupported":
    case "unresolved":
      return `${resolution.kind}:${resolution.reason}`;
    case "workspace-package":
      return `${resolution.kind}:${resolution.workspacePackageName}:${resolution.subpath}`;
  }
}

function compareEdges(
  left: ObservedSourceDependencyEdge,
  right: ObservedSourceDependencyEdge
): number {
  return (
    compareBinaryStrings(left.fromPath, right.fromPath) ||
    compareBinaryStrings(left.mode, right.mode) ||
    compareBinaryStrings(left.kind, right.kind) ||
    compareBinaryStrings(left.specifier, right.specifier) ||
    left.start - right.start ||
    left.end - right.end ||
    compareBinaryStrings(resolutionKey(left.resolution), resolutionKey(right.resolution))
  );
}

function normalizeResolution(
  resolved: ResolvedSourceDependency,
  governedFilePaths: ReadonlySet<string>,
  nodesByPath: ReadonlyMap<string, ObservedSourceNode>
): ObservedSourceDependencyResolution {
  switch (resolved.kind) {
    case "builtin":
      return Object.freeze({ kind: resolved.kind, specifier: resolved.specifier });
    case "external-package":
      return Object.freeze({
        kind: resolved.kind,
        packageName: resolved.packageName,
        declaration: resolved.declaration
      });
    case "local-file": {
      const path = normalizeRepositoryPath(resolved.path);
      if (!governedFilePaths.has(path)) {
        return Object.freeze({
          kind: "unresolved",
          reason: "resolver returned a local target outside governed source inventory"
        });
      }
      const targetNode = nodesByPath.get(path);
      if (
        targetNode !== undefined &&
        targetNode.workspacePackageName !== resolved.workspacePackage.name
      ) {
        return Object.freeze({
          kind: "unresolved",
          reason: "resolver returned a local target with a mismatched workspace package"
        });
      }
      return Object.freeze({
        kind: resolved.kind,
        path,
        workspacePackageName: resolved.workspacePackage.name,
        workspacePackageManifestPath: resolved.workspacePackage.manifestPath,
        targetBoundaryId: targetNode?.boundaryId ?? null
      });
    }
    case "generated-output-candidate":
      return Object.freeze({
        kind: resolved.kind,
        path: normalizeRepositoryPath(resolved.path),
        workspacePackageName: resolved.workspacePackage.name,
        workspacePackageManifestPath: resolved.workspacePackage.manifestPath
      });
    case "self-workspace-package":
      return Object.freeze({
        kind: resolved.kind,
        workspacePackageName: resolved.workspacePackage.name,
        workspacePackageManifestPath: resolved.workspacePackage.manifestPath,
        exported: resolved.exported,
        subpath: resolved.subpath
      });
    case "unsupported":
    case "unresolved":
      return Object.freeze({ kind: resolved.kind, reason: resolved.reason });
    case "workspace-package":
      return Object.freeze({
        kind: resolved.kind,
        workspacePackageName: resolved.workspacePackage.name,
        workspacePackageManifestPath: resolved.workspacePackage.manifestPath,
        declaration: resolved.declaration,
        exported: resolved.exported,
        subpath: resolved.subpath
      });
  }
}

function createNode(file: ClassifiedSourceFile): ObservedSourceNode {
  return Object.freeze({
    path: file.path,
    boundaryId: file.boundary.id,
    workspacePackageName: file.workspacePackage.name,
    workspacePackageManifestPath: file.workspacePackage.manifestPath
  });
}

/**
 * Collects all static evidence once. Later policies only inspect this immutable
 * graph and do not invoke the parser or resolver again.
 */
export function buildObservedSourceGraph(
  input: BuildObservedSourceGraphInput
): ObservedSourceGraph {
  const sourcePaths = normalizedSourcePaths(input.allSourceFiles);
  const governedFilePaths = new Set(sourcePaths);
  const normalizedClassified = input.classifiedFiles
    .map(normalizedClassifiedFile)
    .toSorted((left, right) => compareBinaryStrings(left.path, right.path));
  const nodes: ObservedSourceNode[] = [];
  const nodesByPath = new Map<string, ObservedSourceNode>();

  for (const file of normalizedClassified) {
    assertNotCancelled(input.signal);
    if (!governedFilePaths.has(file.path)) {
      inputError(
        "OBSERVED_SOURCE_GRAPH_CLASSIFICATION_OUTSIDE_INVENTORY",
        `Classified source is absent from governed source inventory: ${file.path}.`
      );
    }
    if (nodesByPath.has(file.path)) {
      inputError(
        "OBSERVED_SOURCE_GRAPH_DUPLICATE_CLASSIFICATION",
        `Source has more than one architecture classification: ${file.path}.`
      );
    }
    const node = createNode(file);
    nodes.push(node);
    nodesByPath.set(node.path, node);
  }

  const edges: ObservedSourceDependencyEdge[] = [];
  const parseFailures: ObservedSourceGraph["parseFailures"][number][] = [];
  const unresolvedRuntimeReferences: ObservedUnresolvedRuntimeReference[] = [];

  for (const file of normalizedClassified) {
    assertNotCancelled(input.signal);
    const node = nodesByPath.get(file.path);
    if (node === undefined) {
      inputError(
        "OBSERVED_SOURCE_GRAPH_NODE_MISSING",
        `Classified source graph node is missing: ${file.path}.`
      );
    }
    if (file.parsed.parseErrorCount > 0) {
      parseFailures.push(
        Object.freeze({ path: file.path, parseErrorCount: file.parsed.parseErrorCount })
      );
      continue;
    }
    for (const unresolved of file.parsed.unresolved) {
      unresolvedRuntimeReferences.push(
        Object.freeze({
          path: file.path,
          boundaryId: node.boundaryId,
          kind: unresolved.kind,
          start: unresolved.start,
          end: unresolved.end
        })
      );
    }
    for (const reference of file.parsed.references) {
      assertNotCancelled(input.signal);
      const workspacePackageRootIdentity = input.workspacePackageRootIdentities?.get(
        file.workspacePackage.manifestPath
      );
      edges.push(
        Object.freeze({
          fromPath: node.path,
          fromBoundaryId: node.boundaryId,
          fromWorkspacePackageName: node.workspacePackageName,
          fromWorkspacePackageManifestPath: node.workspacePackageManifestPath,
          kind: reference.kind,
          mode: edgeMode(reference.kind),
          specifier: reference.specifier,
          start: reference.start,
          end: reference.end,
          resolution: normalizeResolution(
            input.resolver.resolve({
              consumerRoot: input.consumerRoot ?? ".",
              ...(input.consumerRootIdentity === undefined
                ? {}
                : { consumerRootIdentity: input.consumerRootIdentity }),
              enforceWorkspaceBindings: input.enforceWorkspaceBindings ?? false,
              file,
              governedFilePaths,
              ...(input.governedWorkspacePackageManifestPaths === undefined
                ? {}
                : {
                    governedWorkspacePackageManifestPaths:
                      input.governedWorkspacePackageManifestPaths
                  }),
              inventory: input.inventory,
              ...(input.packageTypeScopes === undefined
                ? {}
                : { packageTypeScopes: input.packageTypeScopes }),
              reference,
              ...(workspacePackageRootIdentity === undefined
                ? {}
                : { workspacePackageRootIdentity })
            }),
            governedFilePaths,
            nodesByPath
          )
        })
      );
    }
  }

  const classifiedPaths = new Set(nodesByPath.keys());
  return Object.freeze({
    nodes: Object.freeze(nodes.toSorted(compareNodes)),
    edges: Object.freeze(edges.toSorted(compareEdges)),
    parseFailures: Object.freeze(
      parseFailures.toSorted(
        (left, right) =>
          compareBinaryStrings(left.path, right.path) ||
          left.parseErrorCount - right.parseErrorCount
      )
    ),
    unclassifiedSourcePaths: Object.freeze(
      sourcePaths.filter((path) => !classifiedPaths.has(path))
    ),
    unresolvedRuntimeReferences: Object.freeze(
      unresolvedRuntimeReferences.toSorted(
        (left, right) =>
          compareBinaryStrings(left.path, right.path) ||
          left.start - right.start ||
          compareBinaryStrings(left.kind, right.kind) ||
          left.end - right.end
      )
    )
  });
}

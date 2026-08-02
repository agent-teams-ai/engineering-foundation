import { CapabilityInputError } from "../../../../capability-runtime.js";
import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type { SourceFileSnapshot } from "../../../../source-inventory/application/model/source-file-snapshot.js";
import type { SourceTreeReader } from "../../../../source-inventory/application/ports/source-tree-reader.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { WorkspacePackage } from "../../../../workspace-inventory/application/model/workspace-inventory.js";
import type { WorkspaceInventoryReader } from "../../../../workspace-inventory/application/ports/workspace-inventory-reader.js";
import type {
  ArchitectureBoundaryPolicy,
  ClassifiedSourceFile,
  SourceArchitecturePolicy
} from "../model/source-workspace.js";
import {
  normalizeRepositoryPath,
  pathIsInside
} from "../model/repository-path.js";
import type { SourceDependencyParser } from "../ports/source-dependency-parser.js";
import type { SourceDependencyResolver } from "../ports/source-dependency-resolver.js";
import { evaluateSourceDependencies } from "../policies/evaluate-source-dependencies.js";
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
}

function pathInside(path: string, root: string): boolean {
  return pathIsInside(path, root);
}

function deepestBoundary(
  file: SourceFileSnapshot,
  boundaries: readonly ArchitectureBoundaryPolicy[]
): ArchitectureBoundaryPolicy | undefined {
  return boundaries
    .filter((boundary) => boundary.roots.some((root) => pathInside(file.path, root)))
    .toSorted(
      (left, right) =>
        Math.max(...right.roots.map((root) => root.length)) -
          Math.max(...left.roots.map((root) => root.length)) ||
        left.id.localeCompare(right.id)
    )[0];
}

function containingPackage(
  path: string,
  packages: readonly WorkspacePackage[]
): WorkspacePackage | undefined {
  return packages
    .filter((workspacePackage) =>
      workspacePackage.rootPath === "."
        ? true
        : pathInside(path, workspacePackage.rootPath)
    )
    .toSorted(
      (left, right) =>
        right.rootPath.length - left.rootPath.length ||
        left.name.localeCompare(right.name)
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
    const boundary = deepestBoundary(normalizedFile, policy.boundaries);
    const workspacePackage = containingPackage(normalizedFile.path, packages);
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

export async function analyzeSourceDependencies(
  input: AnalyzeSourceDependenciesInput,
  dependencies: AnalyzeSourceDependenciesDependencies
): Promise<readonly FoundationDiagnostic[]> {
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

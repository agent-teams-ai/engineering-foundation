import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { assertNotCancelled } from "../../../../cancellation.js";
import { CapabilityInputError } from "../../../../capability-runtime.js";
import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type { SourceFileSnapshot } from "../../../../source-inventory/application/model/source-file-snapshot.js";
import type { SourceTreeReader } from "../../../../source-inventory/application/ports/source-tree-reader.js";
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

interface BoundaryMatch {
  readonly boundary: ArchitectureBoundaryPolicy;
  readonly specificity: number;
}

function matchingBoundarySpecificity(
  path: string,
  boundary: ArchitectureBoundaryPolicy
): number | undefined {
  const matchingRoots = boundary.roots
    .filter((root) => pathInside(path, root))
    .map((root) => normalizeRepositoryPath(root).length);
  return matchingRoots.length === 0 ? undefined : Math.max(...matchingRoots);
}

function selectBoundary(
  file: SourceFileSnapshot,
  policy: SourceArchitecturePolicy
): ArchitectureBoundaryPolicy | undefined {
  const matches: BoundaryMatch[] = [];
  for (const boundary of policy.boundaries) {
    const specificity = matchingBoundarySpecificity(file.path, boundary);
    if (specificity !== undefined) {
      matches.push({ boundary, specificity });
    }
  }
  if (matches.length === 0) {
    return undefined;
  }

  const highestSpecificity = Math.max(...matches.map((match) => match.specificity));
  const mostSpecific = matches
    .filter((match) => match.specificity === highestSpecificity)
    .toSorted((left, right) => compareBinaryStrings(left.boundary.id, right.boundary.id));

  if (policy.schemaVersion === 2 && mostSpecific.length > 1) {
    const candidateIds = mostSpecific.map((match) => match.boundary.id).join(", ");
    throw new CapabilityInputError({
      code: "SOURCE_BOUNDARY_AMBIGUOUS",
      message: `Source file matches multiple equally specific architecture boundaries: ${file.path} (${candidateIds}).`,
      phase: "source-boundary-classification",
      retryable: false
    });
  }

  // Schema v1 did not reject ties. Retain its deterministic lexical fallback
  // while still fixing the non-matching-root ranking bug for both versions.
  return mostSpecific[0]?.boundary;
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

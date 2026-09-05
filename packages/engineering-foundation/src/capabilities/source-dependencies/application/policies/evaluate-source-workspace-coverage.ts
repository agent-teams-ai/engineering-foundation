import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import { portablePathIsInside } from "../model/repository-path.js";
import type {
  SourceWorkspacePackageTopology,
  SourceWorkspaceTopology
} from "../model/source-workspace-topology.js";
import type { SourceArchitecturePolicy } from "../model/source-workspace.js";
import { SOURCE_DEPENDENCY_RULES } from "../rules.js";

function topologyError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "source-workspace-topology",
    retryable: false
  });
}

function owningPackage(
  path: string,
  packages: readonly SourceWorkspacePackageTopology[]
): SourceWorkspacePackageTopology | undefined {
  return packages
    .filter((workspacePackage) =>
      portablePathIsInside(path, workspacePackage.rootPath)
    )
    .toSorted(
      (left, right) =>
        right.rootPath.length - left.rootPath.length ||
        compareBinaryStrings(left.rootPath, right.rootPath)
    )[0];
}

function assertGovernedRootOwnership(
  policy: SourceArchitecturePolicy,
  packages: readonly SourceWorkspacePackageTopology[]
): void {
  for (const root of policy.governedRoots.toSorted(compareBinaryStrings)) {
    if (owningPackage(root, packages) === undefined) {
      topologyError(
        "SOURCE_ROOT_OUTSIDE_WORKSPACE",
        `Governed root is outside the schema v2 packageRoots contract: ${root}.`
      );
    }
  }
}

function assertBoundaryOwnership(
  policy: SourceArchitecturePolicy,
  packages: readonly SourceWorkspacePackageTopology[]
): void {
  for (const boundary of policy.boundaries) {
    const paths = [...boundary.roots, ...boundary.entrypoints].toSorted(
      compareBinaryStrings
    );
    const owners = new Map<string, SourceWorkspacePackageTopology>();
    for (const path of paths) {
      const owner = owningPackage(path, packages);
      if (owner === undefined) {
        topologyError(
          "SOURCE_ROOT_OUTSIDE_WORKSPACE",
          `Architecture boundary path belongs to no selected package: ${boundary.id}:${path}.`
        );
      }
      owners.set(owner.rootPath, owner);
    }
    if (owners.size !== 1) {
      topologyError(
        "SOURCE_BOUNDARY_SPANS_PACKAGES",
        `Architecture boundary spans npm packages: ${boundary.id} (${[...owners.values()]
          .map((owner) => owner.name)
          .toSorted(compareBinaryStrings)
          .join(", ")}).`
      );
    }
  }
}

function packageHasGovernedRoot(
  workspacePackage: SourceWorkspacePackageTopology,
  governedRoots: readonly string[],
  packages: readonly SourceWorkspacePackageTopology[]
): boolean {
  return governedRoots.some(
    (root) => owningPackage(root, packages)?.rootPath === workspacePackage.rootPath
  );
}

function uncoveredSourceDiagnostics(
  policy: SourceArchitecturePolicy,
  workspacePackage: SourceWorkspacePackageTopology,
  packages: readonly SourceWorkspacePackageTopology[]
): readonly FoundationDiagnostic[] {
  return workspacePackage.sourcePaths
    .filter(
      (path) =>
        owningPackage(path, packages)?.rootPath === workspacePackage.rootPath &&
        !policy.governedRoots.some((root) => portablePathIsInside(path, root))
    )
    .toSorted(compareBinaryStrings)
    .map((path) => ({
      ruleId: SOURCE_DEPENDENCY_RULES.unclassifiedSourceFile.id,
      severity: SOURCE_DEPENDENCY_RULES.unclassifiedSourceFile.severity,
      subject: path,
      message: `Workspace source file is outside declared governed roots: ${path}.`,
      location: { path },
      relatedLocations: [{ path: workspacePackage.manifestPath }],
      evidence: [
        { kind: "workspace-package", value: workspacePackage.name },
        { kind: "package-root", value: workspacePackage.rootPath }
      ],
      remediation: SOURCE_DEPENDENCY_RULES.unclassifiedSourceFile.remediation,
      requiresArchitectureReview:
        SOURCE_DEPENDENCY_RULES.unclassifiedSourceFile.requiresArchitectureReview
    }));
}

export function evaluateSourceWorkspaceCoverage(
  policy: SourceArchitecturePolicy,
  topology: SourceWorkspaceTopology
): readonly FoundationDiagnostic[] {
  assertGovernedRootOwnership(policy, topology.packages);
  assertBoundaryOwnership(policy, topology.packages);
  const diagnostics: FoundationDiagnostic[] = [];
  for (const workspacePackage of topology.packages.toSorted((left, right) =>
    compareBinaryStrings(left.rootPath, right.rootPath)
  )) {
    if (
      !packageHasGovernedRoot(
        workspacePackage,
        policy.governedRoots,
        topology.packages
      ) &&
      workspacePackage.rootPath !== "."
    ) {
      diagnostics.push({
        ruleId: SOURCE_DEPENDENCY_RULES.uncoveredWorkspacePackageRoot.id,
        severity: SOURCE_DEPENDENCY_RULES.uncoveredWorkspacePackageRoot.severity,
        subject: workspacePackage.rootPath,
        message: `Workspace package root has no declared governed source root: ${workspacePackage.rootPath}.`,
        location: { path: workspacePackage.manifestPath },
        relatedLocations: [],
        evidence: [
          { kind: "workspace-package", value: workspacePackage.name },
          { kind: "package-root", value: workspacePackage.rootPath }
        ],
        remediation: SOURCE_DEPENDENCY_RULES.uncoveredWorkspacePackageRoot.remediation,
        requiresArchitectureReview:
          SOURCE_DEPENDENCY_RULES.uncoveredWorkspacePackageRoot
            .requiresArchitectureReview
      });
      continue;
    }
    diagnostics.push(
      ...uncoveredSourceDiagnostics(policy, workspacePackage, topology.packages)
    );
  }
  return Object.freeze(diagnostics);
}

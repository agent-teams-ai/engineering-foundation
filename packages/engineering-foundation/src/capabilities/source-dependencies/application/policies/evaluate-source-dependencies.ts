import type {
  DiagnosticEvidence,
  FoundationDiagnostic
} from "../../../../check-contract.js";
import type {
  ArchitectureBoundaryPolicy,
  ObservedSourceDependencyEdge,
  ObservedSourceGraph,
  SourceArchitecturePolicy
} from "../model/source-workspace.js";
import { evaluateSourceDependencyCycles } from "./evaluate-source-dependency-cycles.js";
import {
  SOURCE_DEPENDENCY_RULES,
  type SourceDependencyRuleMetadata
} from "../rules.js";

interface EvaluationInput {
  readonly policy: SourceArchitecturePolicy;
  readonly graph: ObservedSourceGraph;
}

function diagnostic(input: {
  readonly rule: SourceDependencyRuleMetadata;
  readonly subject: string;
  readonly message: string;
  readonly path: string;
  readonly evidence?: readonly DiagnosticEvidence[];
  readonly relatedPath?: string;
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations:
      input.relatedPath === undefined ? [] : [{ path: input.relatedPath }],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function declarationDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly packageName: string;
  readonly declaration: "development" | "runtime" | "undeclared";
  readonly workspace: boolean;
}): readonly FoundationDiagnostic[] {
  if (input.declaration === "runtime") {
    return [];
  }
  const rule =
    input.declaration === "development"
      ? SOURCE_DEPENDENCY_RULES.runtimeImportFromDevelopmentDependency
      : input.workspace
        ? SOURCE_DEPENDENCY_RULES.undeclaredWorkspaceDependency
        : SOURCE_DEPENDENCY_RULES.undeclaredExternalDependency;
  return [
    diagnostic({
      rule,
      subject: `${input.edge.fromWorkspacePackageName}->${input.packageName}`,
      message:
        input.declaration === "development"
          ? `Runtime source imports development-only dependency ${input.packageName}.`
          : `Runtime source imports undeclared dependency ${input.packageName}.`,
      path: input.edge.fromPath,
      relatedPath: input.edge.fromWorkspacePackageManifestPath,
      evidence: [{ kind: "specifier", value: input.edge.specifier }]
    })
  ];
}

function exportDiagnostic(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly packageName: string;
  readonly manifestPath: string;
  readonly exported: boolean;
  readonly subpath: string;
}): readonly FoundationDiagnostic[] {
  return input.exported
    ? []
    : [
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.packageSubpathNotExported,
          subject: `${input.packageName}:${input.subpath}`,
          message: `Workspace package subpath is not exported: ${input.edge.specifier}.`,
          path: input.edge.fromPath,
          relatedPath: input.manifestPath,
          evidence: [{ kind: "subpath", value: input.subpath }]
        })
      ];
}

function selfPackageImportDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly packageName: string;
  readonly manifestPath: string;
  readonly exported: boolean;
  readonly subpath: string;
}): readonly FoundationDiagnostic[] {
  return [
    diagnostic({
      rule: SOURCE_DEPENDENCY_RULES.selfPackageImportBoundaryUnresolved,
      subject: `${input.edge.fromBoundaryId}->${input.packageName}:${input.subpath}`,
      message: `Package-name import into ${input.packageName} cannot prove a source-boundary target and is blocked.`,
      path: input.edge.fromPath,
      relatedPath: input.manifestPath,
      evidence: [
        { kind: "specifier", value: input.edge.specifier },
        { kind: "workspace-subpath", value: input.subpath }
      ]
    }),
    ...exportDiagnostic(input)
  ];
}

function boundaryEntrypointDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly policy: SourceArchitecturePolicy;
  readonly targetBoundary: ArchitectureBoundaryPolicy;
  readonly targetPath: string;
}): readonly FoundationDiagnostic[] {
  if (
    input.policy.schemaVersion !== 2 ||
    input.targetBoundary.entrypoints.includes(input.targetPath)
  ) {
    return [];
  }
  return [
    diagnostic({
      rule: SOURCE_DEPENDENCY_RULES.crossBoundaryLocalImportNotEntrypoint,
      subject: `${input.edge.fromBoundaryId}->${input.targetBoundary.id}:${input.targetPath}`,
      message: `Cross-boundary local import targets ${input.targetPath}, which is not a declared entrypoint of ${input.targetBoundary.id}.`,
      path: input.edge.fromPath,
      relatedPath: input.targetPath,
      evidence: [
        { kind: "specifier", value: input.edge.specifier },
        { kind: "target-boundary", value: input.targetBoundary.id },
        { kind: "target-path", value: input.targetPath }
      ]
    })
  ];
}

function evaluateResolved(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly policy: SourceArchitecturePolicy;
  readonly boundariesById: ReadonlyMap<string, ArchitectureBoundaryPolicy>;
}): readonly FoundationDiagnostic[] {
  const { edge } = input;
  const sourceBoundary = input.boundariesById.get(edge.fromBoundaryId);
  if (sourceBoundary === undefined) {
    return [];
  }
  switch (edge.resolution.kind) {
    case "builtin":
      return sourceBoundary.allowedBuiltins.includes(edge.resolution.specifier)
        ? []
        : [
            diagnostic({
              rule: SOURCE_DEPENDENCY_RULES.forbiddenBuiltinDependency,
              subject: `${sourceBoundary.id}->${edge.resolution.specifier}`,
              message: `Boundary ${sourceBoundary.id} cannot import ${edge.resolution.specifier}.`,
              path: edge.fromPath,
              evidence: [{ kind: "specifier", value: edge.specifier }]
            })
          ];
    case "external-package":
      return [
        ...(sourceBoundary.allowedPackages.includes(edge.resolution.packageName)
          ? []
          : [
              diagnostic({
                rule: SOURCE_DEPENDENCY_RULES.forbiddenPackageDependency,
                subject: `${sourceBoundary.id}->${edge.resolution.packageName}`,
                message: `Boundary ${sourceBoundary.id} cannot import package ${edge.resolution.packageName}.`,
                path: edge.fromPath,
                evidence: [{ kind: "specifier", value: edge.specifier }]
              })
            ]),
        ...declarationDiagnostics({
          edge,
          packageName: edge.resolution.packageName,
          declaration: edge.resolution.declaration,
          workspace: false
        })
      ];
    case "local-file": {
      if (edge.resolution.workspacePackageName !== edge.fromWorkspacePackageName) {
        return [
          diagnostic({
            rule: SOURCE_DEPENDENCY_RULES.crossPackageRelativeImport,
            subject: `${edge.fromWorkspacePackageName}->${edge.resolution.workspacePackageName}`,
            message: `Relative import crosses from ${edge.fromWorkspacePackageName} into ${edge.resolution.workspacePackageName}.`,
            path: edge.fromPath,
            relatedPath: edge.resolution.path,
            evidence: [{ kind: "specifier", value: edge.specifier }]
          })
        ];
      }
      const targetBoundary =
        edge.resolution.targetBoundaryId === null
          ? undefined
          : input.boundariesById.get(edge.resolution.targetBoundaryId);
      if (targetBoundary === undefined || targetBoundary.id === sourceBoundary.id) {
        return [];
      }
      return [
        ...(sourceBoundary.allowedBoundaries.includes(targetBoundary.id)
          ? []
          : [
              diagnostic({
                rule: SOURCE_DEPENDENCY_RULES.forbiddenBoundaryDependency,
                subject: `${sourceBoundary.id}->${targetBoundary.id}`,
                message: `Boundary dependency is not allowed: ${sourceBoundary.id} -> ${targetBoundary.id}.`,
                path: edge.fromPath,
                relatedPath: edge.resolution.path,
                evidence: [{ kind: "specifier", value: edge.specifier }]
              })
            ]),
        ...boundaryEntrypointDiagnostics({
          edge,
          policy: input.policy,
          targetBoundary,
          targetPath: edge.resolution.path
        })
      ];
    }
    case "self-workspace-package":
      return selfPackageImportDiagnostics({
        edge,
        packageName: edge.resolution.workspacePackageName,
        manifestPath: edge.resolution.workspacePackageManifestPath,
        exported: edge.resolution.exported,
        subpath: edge.resolution.subpath
      });
    case "unsupported":
      return [
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.unsupportedImportSpecifier,
          subject: `${edge.fromPath}:${edge.specifier}`,
          message: `Import specifier cannot be classified: ${edge.resolution.reason}.`,
          path: edge.fromPath,
          evidence: [{ kind: "specifier", value: edge.specifier }]
        })
      ];
    case "unresolved":
      return [
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.unresolvedLocalImport,
          subject: `${edge.fromPath}:${edge.specifier}`,
          message: `Import could not be resolved: ${edge.resolution.reason}.`,
          path: edge.fromPath,
          evidence: [{ kind: "specifier", value: edge.specifier }]
        })
      ];
    case "workspace-package":
      if (edge.resolution.workspacePackageName === edge.fromWorkspacePackageName) {
        return selfPackageImportDiagnostics({
          edge,
          packageName: edge.resolution.workspacePackageName,
          manifestPath: edge.resolution.workspacePackageManifestPath,
          exported: edge.resolution.exported,
          subpath: edge.resolution.subpath
        });
      }
      return [
        ...(sourceBoundary.allowedPackages.includes(edge.resolution.workspacePackageName)
          ? []
          : [
              diagnostic({
                rule: SOURCE_DEPENDENCY_RULES.forbiddenPackageDependency,
                subject: `${sourceBoundary.id}->${edge.resolution.workspacePackageName}`,
                message: `Boundary ${sourceBoundary.id} cannot import workspace package ${edge.resolution.workspacePackageName}.`,
                path: edge.fromPath,
                relatedPath: edge.resolution.workspacePackageManifestPath,
                evidence: [{ kind: "specifier", value: edge.specifier }]
              })
            ]),
        ...declarationDiagnostics({
          edge,
          packageName: edge.resolution.workspacePackageName,
          declaration: edge.resolution.declaration,
          workspace: true
        }),
        ...exportDiagnostic({
          edge,
          packageName: edge.resolution.workspacePackageName,
          manifestPath: edge.resolution.workspacePackageManifestPath,
          exported: edge.resolution.exported,
          subpath: edge.resolution.subpath
        })
      ];
  }
}

function entrypointDeclarationDiagnostics(
  policy: SourceArchitecturePolicy,
  graph: ObservedSourceGraph
): readonly FoundationDiagnostic[] {
  if (policy.schemaVersion !== 2) {
    return [];
  }
  const nodesByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const diagnostics: FoundationDiagnostic[] = [];
  for (const boundary of policy.boundaries) {
    for (const entrypoint of boundary.entrypoints) {
      const node = nodesByPath.get(entrypoint);
      if (node !== undefined && node.boundaryId === boundary.id) {
        continue;
      }
      diagnostics.push(
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.invalidBoundaryEntrypoint,
          subject: `${boundary.id}:${entrypoint}`,
          message:
            node === undefined
              ? `Boundary entrypoint is not a governed classified source file: ${entrypoint}.`
              : `Boundary entrypoint belongs to ${node.boundaryId}, not ${boundary.id}: ${entrypoint}.`,
          path: entrypoint,
          evidence: [{ kind: "boundary", value: boundary.id }]
        })
      );
    }
  }
  return diagnostics;
}

export function evaluateSourceDependencies(
  input: EvaluationInput
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const boundariesById = new Map(
    input.policy.boundaries.map((boundary) => [boundary.id, boundary])
  );
  for (const path of input.graph.unclassifiedSourcePaths) {
    diagnostics.push(
      diagnostic({
        rule: SOURCE_DEPENDENCY_RULES.unclassifiedSourceFile,
        subject: path,
        message: "Governed source file does not belong to an architecture boundary.",
        path
      })
    );
  }
  for (const failure of input.graph.parseFailures) {
    diagnostics.push(
      diagnostic({
        rule: SOURCE_DEPENDENCY_RULES.sourceParseError,
        subject: failure.path,
        message: `Source parser reported ${failure.parseErrorCount} error(s).`,
        path: failure.path,
        evidence: [{ kind: "parse-error-count", value: String(failure.parseErrorCount) }]
      })
    );
  }
  for (const unresolvedReference of input.graph.unresolvedRuntimeReferences) {
    const boundary = boundariesById.get(unresolvedReference.boundaryId);
    if (boundary?.allowedRuntimeReferences.includes(unresolvedReference.kind) === true) {
      continue;
    }
    diagnostics.push(
      diagnostic({
        rule: SOURCE_DEPENDENCY_RULES.unresolvedRuntimeReference,
        subject: `${unresolvedReference.path}:${unresolvedReference.kind}:${unresolvedReference.start}`,
        message: `Non-literal ${unresolvedReference.kind} reference hides a dependency edge.`,
        path: unresolvedReference.path,
        evidence: [
          { kind: "reference-kind", value: unresolvedReference.kind },
          { kind: "offset", value: String(unresolvedReference.start) }
        ]
      })
    );
  }
  diagnostics.push(...entrypointDeclarationDiagnostics(input.policy, input.graph));
  for (const edge of input.graph.edges) {
    diagnostics.push(
      ...evaluateResolved({
        edge,
        policy: input.policy,
        boundariesById
      })
    );
  }
  diagnostics.push(...evaluateSourceDependencyCycles(input.graph));
  return diagnostics;
}

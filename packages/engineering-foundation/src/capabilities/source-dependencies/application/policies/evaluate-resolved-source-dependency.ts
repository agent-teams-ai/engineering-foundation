import type {
  DiagnosticEvidence,
  FoundationDiagnostic
} from "../../../../check-contract.js";
import type {
  ArchitectureBoundaryPolicy,
  ObservedSourceDependencyEdge,
  ObservedSourceDependencyResolution,
  SourceArchitecturePolicy
} from "../model/source-workspace.js";
import {
  SOURCE_DEPENDENCY_RULES,
  type SourceDependencyRuleMetadata
} from "../rules.js";

type ResolutionOfKind<Kind extends ObservedSourceDependencyResolution["kind"]> = Extract<
  ObservedSourceDependencyResolution,
  { readonly kind: Kind }
>;

interface EvaluationInput {
  readonly edge: ObservedSourceDependencyEdge;
  readonly policy: SourceArchitecturePolicy;
  readonly boundariesById: ReadonlyMap<string, ArchitectureBoundaryPolicy>;
  readonly developmentBoundariesByPackage: ReadonlyMap<string, readonly string[]>;
}

function diagnostic(input: {
  readonly rule: SourceDependencyRuleMetadata;
  readonly subject: string;
  readonly message: string;
  readonly path: string;
  readonly relatedPath: string | null;
  readonly evidence?: readonly DiagnosticEvidence[];
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations:
      input.relatedPath === null ? [] : [{ path: input.relatedPath }],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function declarationDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly packageName: string;
  readonly declaration: "development" | "runtime" | "undeclared";
  readonly sourceBoundary: ArchitectureBoundaryPolicy;
  readonly workspace: boolean;
}): readonly FoundationDiagnostic[] {
  if (
    input.declaration === "runtime" ||
    (input.declaration === "development" &&
      (input.edge.mode === "type-only" ||
        input.sourceBoundary.dependencyMode === "development"))
  ) {
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
          : `${input.edge.mode === "type-only" ? "Type-only" : "Runtime"} source imports undeclared dependency ${input.packageName}.`,
      path: input.edge.fromPath,
      relatedPath: input.edge.fromWorkspacePackageManifestPath,
      evidence: [{ kind: "specifier", value: input.edge.specifier }]
    })
  ];
}

function exportDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly packageName: string;
  readonly manifestPath: string;
  readonly exported: boolean;
  readonly subpath: string;
}): readonly FoundationDiagnostic[] {
  if (input.exported) {
    return [];
  }
  return [
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

function forbiddenPackageDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly sourceBoundary: ArchitectureBoundaryPolicy;
  readonly packageName: string;
  readonly manifestPath: string | null;
  readonly workspace: boolean;
}): readonly FoundationDiagnostic[] {
  if (input.sourceBoundary.allowedPackages.includes(input.packageName)) {
    return [];
  }
  return [
    diagnostic({
      rule: SOURCE_DEPENDENCY_RULES.forbiddenPackageDependency,
      subject: `${input.sourceBoundary.id}->${input.packageName}`,
      message: input.workspace
        ? `Boundary ${input.sourceBoundary.id} cannot import workspace package ${input.packageName}.`
        : `Boundary ${input.sourceBoundary.id} cannot import package ${input.packageName}.`,
      path: input.edge.fromPath,
      relatedPath: input.manifestPath,
      evidence: [{ kind: "specifier", value: input.edge.specifier }]
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
    ...exportDiagnostics(input)
  ];
}

function boundaryEntrypointDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly targetBoundary: ArchitectureBoundaryPolicy;
  readonly targetPath: string;
}): readonly FoundationDiagnostic[] {
  if (input.targetBoundary.entrypoints.includes(input.targetPath)) {
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

function evaluateBuiltinDependency(
  edge: ObservedSourceDependencyEdge,
  resolution: ResolutionOfKind<"builtin">,
  sourceBoundary: ArchitectureBoundaryPolicy
): readonly FoundationDiagnostic[] {
  if (sourceBoundary.allowedBuiltins.includes(resolution.specifier)) {
    return [];
  }
  return [
    diagnostic({
      rule: SOURCE_DEPENDENCY_RULES.forbiddenBuiltinDependency,
      subject: `${sourceBoundary.id}->${resolution.specifier}`,
      message: `Boundary ${sourceBoundary.id} cannot import ${resolution.specifier}.`,
      path: edge.fromPath,
      relatedPath: null,
      evidence: [{ kind: "specifier", value: edge.specifier }]
    })
  ];
}

function evaluateExternalPackageDependency(
  edge: ObservedSourceDependencyEdge,
  resolution: ResolutionOfKind<"external-package">,
  sourceBoundary: ArchitectureBoundaryPolicy
): readonly FoundationDiagnostic[] {
  return [
    ...forbiddenPackageDiagnostics({
      edge,
      sourceBoundary,
      packageName: resolution.packageName,
      manifestPath: null,
      workspace: false
    }),
    ...declarationDiagnostics({
      edge,
      packageName: resolution.packageName,
      declaration: resolution.declaration,
      sourceBoundary,
      workspace: false
    })
  ];
}

function crossPackageRelativeImportDiagnostic(
  edge: ObservedSourceDependencyEdge,
  resolution: ResolutionOfKind<"local-file">
): FoundationDiagnostic {
  return diagnostic({
    rule: SOURCE_DEPENDENCY_RULES.crossPackageRelativeImport,
    subject: `${edge.fromWorkspacePackageName}->${resolution.workspacePackageName}`,
    message: `Relative import crosses from ${edge.fromWorkspacePackageName} into ${resolution.workspacePackageName}.`,
    path: edge.fromPath,
    relatedPath: resolution.path,
    evidence: [{ kind: "specifier", value: edge.specifier }]
  });
}

function forbiddenBoundaryDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly sourceBoundary: ArchitectureBoundaryPolicy;
  readonly targetBoundary: ArchitectureBoundaryPolicy;
  readonly targetPath: string;
}): readonly FoundationDiagnostic[] {
  if (input.sourceBoundary.allowedBoundaries.includes(input.targetBoundary.id)) {
    return [];
  }
  return [
    diagnostic({
      rule: SOURCE_DEPENDENCY_RULES.forbiddenBoundaryDependency,
      subject: `${input.sourceBoundary.id}->${input.targetBoundary.id}`,
      message: `Boundary dependency is not allowed: ${input.sourceBoundary.id} -> ${input.targetBoundary.id}.`,
      path: input.edge.fromPath,
      relatedPath: input.targetPath,
      evidence: [{ kind: "specifier", value: input.edge.specifier }]
    })
  ];
}

function developmentTargetDiagnostics(input: {
  readonly edge: ObservedSourceDependencyEdge;
  readonly sourceBoundary: ArchitectureBoundaryPolicy;
  readonly targetBoundary: ArchitectureBoundaryPolicy;
  readonly targetPath: string;
}): readonly FoundationDiagnostic[] {
  if (
    input.sourceBoundary.dependencyMode !== "runtime" ||
    input.targetBoundary.dependencyMode !== "development"
  ) {
    return [];
  }
  return [
    diagnostic({
      rule: SOURCE_DEPENDENCY_RULES.runtimeBoundaryImportsDevelopmentBoundary,
      subject: `${input.sourceBoundary.id}->${input.targetBoundary.id}`,
      message: `Runtime boundary ${input.sourceBoundary.id} cannot import development boundary ${input.targetBoundary.id}.`,
      path: input.edge.fromPath,
      relatedPath: input.targetPath,
      evidence: [{ kind: "specifier", value: input.edge.specifier }]
    })
  ];
}

function evaluateLocalFileDependency(input: EvaluationInput & {
  readonly resolution: ResolutionOfKind<"local-file">;
  readonly sourceBoundary: ArchitectureBoundaryPolicy;
}): readonly FoundationDiagnostic[] {
  if (input.resolution.workspacePackageName !== input.edge.fromWorkspacePackageName) {
    return [crossPackageRelativeImportDiagnostic(input.edge, input.resolution)];
  }
  const targetBoundary =
    input.resolution.targetBoundaryId === null
      ? undefined
      : input.boundariesById.get(input.resolution.targetBoundaryId);
  if (targetBoundary === undefined || targetBoundary.id === input.sourceBoundary.id) {
    return [];
  }
  return [
    ...developmentTargetDiagnostics({
      edge: input.edge,
      sourceBoundary: input.sourceBoundary,
      targetBoundary,
      targetPath: input.resolution.path
    }),
    ...forbiddenBoundaryDiagnostics({
      edge: input.edge,
      sourceBoundary: input.sourceBoundary,
      targetBoundary,
      targetPath: input.resolution.path
    }),
    ...boundaryEntrypointDiagnostics({
      edge: input.edge,
      targetBoundary,
      targetPath: input.resolution.path
    })
  ];
}

function evaluateWorkspacePackageDependency(
  edge: ObservedSourceDependencyEdge,
  resolution: ResolutionOfKind<"workspace-package">,
  sourceBoundary: ArchitectureBoundaryPolicy,
  developmentBoundariesByPackage: ReadonlyMap<string, readonly string[]>
): readonly FoundationDiagnostic[] {
  if (resolution.workspacePackageName === edge.fromWorkspacePackageName) {
    return selfPackageImportDiagnostics({
      edge,
      packageName: resolution.workspacePackageName,
      manifestPath: resolution.workspacePackageManifestPath,
      exported: resolution.exported,
      subpath: resolution.subpath
    });
  }
  const developmentBoundaryIds = developmentBoundariesByPackage.get(
    resolution.workspacePackageName
  );
  const developmentPackageDiagnostics =
    sourceBoundary.dependencyMode === "runtime" &&
    developmentBoundaryIds !== undefined
      ? [
          diagnostic({
            rule: SOURCE_DEPENDENCY_RULES.runtimeBoundaryImportsDevelopmentWorkspacePackage,
            subject: `${sourceBoundary.id}->${resolution.workspacePackageName}`,
            message: `Runtime boundary ${sourceBoundary.id} cannot import workspace package ${resolution.workspacePackageName} because that package contains a development boundary and package exports do not prove exact runtime-boundary ownership.`,
            path: edge.fromPath,
            relatedPath: resolution.workspacePackageManifestPath,
            evidence: [
              { kind: "specifier", value: edge.specifier },
              { kind: "development-boundaries", value: developmentBoundaryIds.join(",") }
            ]
          })
        ]
      : [];
  return [
    ...developmentPackageDiagnostics,
    ...forbiddenPackageDiagnostics({
      edge,
      sourceBoundary,
      packageName: resolution.workspacePackageName,
      manifestPath: resolution.workspacePackageManifestPath,
      workspace: true
    }),
    ...declarationDiagnostics({
      edge,
      packageName: resolution.workspacePackageName,
      declaration: resolution.declaration,
      sourceBoundary,
      workspace: true
    }),
    ...exportDiagnostics({
      edge,
      packageName: resolution.workspacePackageName,
      manifestPath: resolution.workspacePackageManifestPath,
      exported: resolution.exported,
      subpath: resolution.subpath
    })
  ];
}

function unclassifiedResolutionDiagnostic(
  edge: ObservedSourceDependencyEdge,
  resolution: ResolutionOfKind<"unsupported"> | ResolutionOfKind<"unresolved">
): FoundationDiagnostic {
  const unsupported = resolution.kind === "unsupported";
  return diagnostic({
    rule: unsupported
      ? SOURCE_DEPENDENCY_RULES.unsupportedImportSpecifier
      : SOURCE_DEPENDENCY_RULES.unresolvedLocalImport,
    subject: `${edge.fromPath}:${edge.specifier}`,
    message: unsupported
      ? `Import specifier cannot be classified: ${resolution.reason}.`
      : `Import could not be resolved: ${resolution.reason}.`,
    path: edge.fromPath,
    relatedPath: null,
    evidence: [{ kind: "specifier", value: edge.specifier }]
  });
}

export function evaluateResolvedSourceDependency(
  input: EvaluationInput
): readonly FoundationDiagnostic[] {
  const sourceBoundary = input.boundariesById.get(input.edge.fromBoundaryId);
  if (sourceBoundary === undefined) {
    return [];
  }
  const { resolution } = input.edge;
  switch (resolution.kind) {
    case "builtin":
      return evaluateBuiltinDependency(input.edge, resolution, sourceBoundary);
    case "external-package":
      return evaluateExternalPackageDependency(input.edge, resolution, sourceBoundary);
    case "local-file":
      return evaluateLocalFileDependency({ ...input, resolution, sourceBoundary });
    case "self-workspace-package":
      return selfPackageImportDiagnostics({
        edge: input.edge,
        packageName: resolution.workspacePackageName,
        manifestPath: resolution.workspacePackageManifestPath,
        exported: resolution.exported,
        subpath: resolution.subpath
      });
    case "unsupported":
    case "unresolved":
      return [unclassifiedResolutionDiagnostic(input.edge, resolution)];
    case "workspace-package":
      return evaluateWorkspacePackageDependency(
        input.edge,
        resolution,
        sourceBoundary,
        input.developmentBoundariesByPackage
      );
  }
}

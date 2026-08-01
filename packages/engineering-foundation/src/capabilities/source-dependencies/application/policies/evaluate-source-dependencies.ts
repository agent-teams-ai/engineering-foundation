import type {
  DiagnosticEvidence,
  FoundationDiagnostic
} from "../../../../check-contract.js";
import type { SourceFileSnapshot } from "../../../../source-inventory/application/model/source-file-snapshot.js";
import type { WorkspaceInventory } from "../../../../workspace-inventory/application/model/workspace-inventory.js";
import type {
  ArchitectureBoundaryPolicy,
  ClassifiedSourceFile,
  ResolvedSourceDependency,
  SourceArchitecturePolicy,
  SourceDependencyReference
} from "../model/source-workspace.js";
import type { SourceDependencyResolver } from "../ports/source-dependency-resolver.js";
import {
  SOURCE_DEPENDENCY_RULES,
  type SourceDependencyRuleMetadata
} from "../rules.js";

interface EvaluationInput {
  readonly policy: SourceArchitecturePolicy;
  readonly inventory: WorkspaceInventory;
  readonly allSourceFiles: readonly SourceFileSnapshot[];
  readonly classifiedFiles: readonly ClassifiedSourceFile[];
  readonly resolver: SourceDependencyResolver;
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

function boundaryForPath(
  path: string,
  files: readonly ClassifiedSourceFile[]
): ArchitectureBoundaryPolicy | undefined {
  return files.find((file) => file.path === path)?.boundary;
}

function declarationDiagnostics(input: {
  readonly file: ClassifiedSourceFile;
  readonly reference: SourceDependencyReference;
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
      subject: `${input.file.workspacePackage.name}->${input.packageName}`,
      message:
        input.declaration === "development"
          ? `Runtime source imports development-only dependency ${input.packageName}.`
          : `Runtime source imports undeclared dependency ${input.packageName}.`,
      path: input.file.path,
      relatedPath: input.file.workspacePackage.manifestPath,
      evidence: [{ kind: "specifier", value: input.reference.specifier }]
    })
  ];
}

function evaluateResolved(input: {
  readonly file: ClassifiedSourceFile;
  readonly reference: SourceDependencyReference;
  readonly resolved: ResolvedSourceDependency;
  readonly classifiedFiles: readonly ClassifiedSourceFile[];
}): readonly FoundationDiagnostic[] {
  const { file, reference, resolved } = input;
  switch (resolved.kind) {
    case "builtin":
      return file.boundary.allowedBuiltins.includes(resolved.specifier)
        ? []
        : [
            diagnostic({
              rule: SOURCE_DEPENDENCY_RULES.forbiddenBuiltinDependency,
              subject: `${file.boundary.id}->${resolved.specifier}`,
              message: `Boundary ${file.boundary.id} cannot import ${resolved.specifier}.`,
              path: file.path,
              evidence: [{ kind: "specifier", value: reference.specifier }]
            })
          ];
    case "external-package":
      return [
        ...(file.boundary.allowedPackages.includes(resolved.packageName)
          ? []
          : [
              diagnostic({
                rule: SOURCE_DEPENDENCY_RULES.forbiddenPackageDependency,
                subject: `${file.boundary.id}->${resolved.packageName}`,
                message: `Boundary ${file.boundary.id} cannot import package ${resolved.packageName}.`,
                path: file.path,
                evidence: [{ kind: "specifier", value: reference.specifier }]
              })
            ]),
        ...declarationDiagnostics({
          file,
          reference,
          packageName: resolved.packageName,
          declaration: resolved.declaration,
          workspace: false
        })
      ];
    case "local-file": {
      if (resolved.workspacePackage.name !== file.workspacePackage.name) {
        return [
          diagnostic({
            rule: SOURCE_DEPENDENCY_RULES.crossPackageRelativeImport,
            subject: `${file.workspacePackage.name}->${resolved.workspacePackage.name}`,
            message: `Relative import crosses from ${file.workspacePackage.name} into ${resolved.workspacePackage.name}.`,
            path: file.path,
            relatedPath: resolved.path,
            evidence: [{ kind: "specifier", value: reference.specifier }]
          })
        ];
      }
      const targetBoundary = boundaryForPath(resolved.path, input.classifiedFiles);
      if (
        targetBoundary === undefined ||
        targetBoundary.id === file.boundary.id ||
        file.boundary.allowedBoundaries.includes(targetBoundary.id)
      ) {
        return [];
      }
      return [
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.forbiddenBoundaryDependency,
          subject: `${file.boundary.id}->${targetBoundary.id}`,
          message: `Boundary dependency is not allowed: ${file.boundary.id} -> ${targetBoundary.id}.`,
          path: file.path,
          relatedPath: resolved.path,
          evidence: [{ kind: "specifier", value: reference.specifier }]
        })
      ];
    }
    case "unsupported":
      return [
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.unsupportedImportSpecifier,
          subject: `${file.path}:${reference.specifier}`,
          message: `Import specifier cannot be classified: ${resolved.reason}.`,
          path: file.path,
          evidence: [{ kind: "specifier", value: reference.specifier }]
        })
      ];
    case "unresolved":
      return [
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.unresolvedLocalImport,
          subject: `${file.path}:${reference.specifier}`,
          message: `Import could not be resolved: ${resolved.reason}.`,
          path: file.path,
          evidence: [{ kind: "specifier", value: reference.specifier }]
        })
      ];
    case "workspace-package":
      return [
        ...(
          resolved.workspacePackage.name === file.workspacePackage.name ||
          file.boundary.allowedPackages.includes(resolved.workspacePackage.name)
            ? []
            : [
                diagnostic({
                  rule: SOURCE_DEPENDENCY_RULES.forbiddenPackageDependency,
                  subject: `${file.boundary.id}->${resolved.workspacePackage.name}`,
                  message: `Boundary ${file.boundary.id} cannot import workspace package ${resolved.workspacePackage.name}.`,
                  path: file.path,
                  relatedPath: resolved.workspacePackage.manifestPath,
                  evidence: [{ kind: "specifier", value: reference.specifier }]
                })
              ]
        ),
        ...(resolved.workspacePackage.name === file.workspacePackage.name
          ? []
          : declarationDiagnostics({
              file,
              reference,
              packageName: resolved.workspacePackage.name,
              declaration: resolved.declaration,
              workspace: true
            })),
        ...(resolved.exported
          ? []
          : [
              diagnostic({
                rule: SOURCE_DEPENDENCY_RULES.packageSubpathNotExported,
                subject: `${resolved.workspacePackage.name}:${resolved.subpath}`,
                message: `Workspace package subpath is not exported: ${reference.specifier}.`,
                path: file.path,
                relatedPath: resolved.workspacePackage.manifestPath,
                evidence: [{ kind: "subpath", value: resolved.subpath }]
              })
            ])
      ];
  }
}

export function evaluateSourceDependencies(
  input: EvaluationInput
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const classifiedPaths = new Set(input.classifiedFiles.map((file) => file.path));
  const governedFilePaths = new Set(input.allSourceFiles.map((file) => file.path));
  for (const sourceFile of input.allSourceFiles) {
    if (!classifiedPaths.has(sourceFile.path)) {
      diagnostics.push(
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.unclassifiedSourceFile,
          subject: sourceFile.path,
          message: "Governed source file does not belong to an architecture boundary.",
          path: sourceFile.path
        })
      );
    }
  }
  for (const file of input.classifiedFiles) {
    if (file.parsed.parseErrorCount > 0) {
      diagnostics.push(
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.sourceParseError,
          subject: file.path,
          message: `Source parser reported ${file.parsed.parseErrorCount} error(s).`,
          path: file.path,
          evidence: [
            { kind: "parse-error-count", value: String(file.parsed.parseErrorCount) }
          ]
        })
      );
      continue;
    }
    for (const unresolvedReference of file.parsed.unresolved) {
      if (file.boundary.allowedRuntimeReferences.includes(unresolvedReference.kind)) {
        continue;
      }
      diagnostics.push(
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.unresolvedRuntimeReference,
          subject: `${file.path}:${unresolvedReference.kind}:${unresolvedReference.start}`,
          message: `Non-literal ${unresolvedReference.kind} reference hides a dependency edge.`,
          path: file.path,
          evidence: [
            { kind: "reference-kind", value: unresolvedReference.kind },
            { kind: "offset", value: String(unresolvedReference.start) }
          ]
        })
      );
    }
    for (const reference of file.parsed.references) {
      diagnostics.push(
        ...evaluateResolved({
          file,
          reference,
          resolved: input.resolver.resolve({
            file,
            governedFilePaths,
            inventory: input.inventory,
            reference
          }),
          classifiedFiles: input.classifiedFiles
        })
      );
    }
  }
  return diagnostics;
}

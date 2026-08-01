import type { DiagnosticSeverity } from "../../../check-contract.js";

export interface SourceDependencyRuleMetadata {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly rationale: string;
  readonly remediation: string;
  readonly documentation: string;
  readonly requiresArchitectureReview: boolean;
}

function rule(
  suffix: string,
  rationale: string,
  remediation: string,
  requiresArchitectureReview = false
): SourceDependencyRuleMetadata {
  return Object.freeze({
    id: `architecture.source-dependencies.${suffix}`,
    severity: "error",
    rationale,
    remediation,
    documentation: "docs/architecture/executable-capabilities.md#architecturesource-dependencies",
    requiresArchitectureReview
  });
}

export const SOURCE_DEPENDENCY_RULES = Object.freeze({
  crossPackageRelativeImport: rule(
    "cross-package-relative-import",
    "Cross-package relative imports bypass package identity and public exports.",
    "Import the target package through an exported package subpath.",
    true
  ),
  forbiddenBoundaryDependency: rule(
    "forbidden-boundary-dependency",
    "Source boundaries must follow the consumer-owned architecture graph.",
    "Move the dependency behind a port or approve the boundary edge.",
    true
  ),
  forbiddenBuiltinDependency: rule(
    "forbidden-builtin-dependency",
    "Runtime builtins are capabilities that must be explicit per boundary.",
    "Move the builtin access to an adapter or approve it for this boundary.",
    true
  ),
  forbiddenPackageDependency: rule(
    "forbidden-package-dependency",
    "Package dependencies must be explicit per architecture boundary.",
    "Move the import behind a port or approve the package for this boundary.",
    true
  ),
  packageSubpathNotExported: rule(
    "package-subpath-not-exported",
    "Workspace consumers may only import explicit package exports.",
    "Use an existing public entrypoint or deliberately add a package export.",
    true
  ),
  sourceParseError: rule(
    "source-parse-error",
    "Architecture evidence cannot be trusted when governed source does not parse.",
    "Fix the source syntax before evaluating architecture boundaries."
  ),
  undeclaredExternalDependency: rule(
    "undeclared-external-dependency",
    "Runtime source must not rely on undeclared transitive dependencies.",
    "Declare the external package in dependencies, optionalDependencies, or peerDependencies."
  ),
  undeclaredWorkspaceDependency: rule(
    "undeclared-workspace-dependency",
    "An allowed architecture edge still requires an explicit package dependency.",
    "Declare the workspace package with the package manager workspace protocol."
  ),
  unresolvedLocalImport: rule(
    "unresolved-local-import",
    "Unresolved governed imports make the observed dependency graph incomplete.",
    "Use a supported literal import that resolves to a governed source file."
  ),
  unresolvedRuntimeReference: rule(
    "unresolved-runtime-reference",
    "Non-literal runtime loading can hide architecture edges from static evidence.",
    "Centralize dynamic loading behind an approved adapter with literal module references.",
    true
  ),
  runtimeImportFromDevelopmentDependency: rule(
    "runtime-import-from-development-dependency",
    "Published runtime source cannot depend only on development dependencies.",
    "Move the dependency to an appropriate runtime dependency section."
  ),
  unsupportedImportSpecifier: rule(
    "unsupported-import-specifier",
    "Unsupported specifiers cannot be classified reliably by the architecture gate.",
    "Use relative, node builtin, declared external, or governed workspace package imports.",
    true
  ),
  unclassifiedSourceFile: rule(
    "unclassified-source-file",
    "Every governed source file must belong to exactly one declared architecture boundary.",
    "Classify the file in an existing boundary or introduce an explicitly reviewed boundary.",
    true
  )
});

export const SOURCE_DEPENDENCY_RULES_BY_ID: ReadonlyMap<
  string,
  SourceDependencyRuleMetadata
> = new Map(
  Object.values(SOURCE_DEPENDENCY_RULES).map((metadata) => [metadata.id, metadata])
);

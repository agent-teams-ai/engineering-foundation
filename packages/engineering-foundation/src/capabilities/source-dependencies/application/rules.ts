import type { DiagnosticSeverity } from "../../../check-contract.js";
import { createUniqueRegistry } from "../../../unique-registry.js";

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
  boundaryRuntimeCycle: rule(
    "boundary-runtime-cycle",
    "A runtime cycle between architecture boundaries prevents an independent ownership direction.",
    "Break the boundary cycle with a port, event, or extracted shared contract.",
    true
  ),
  boundaryTypeOnlyCycle: rule(
    "boundary-type-only-cycle",
    "A type-only cycle still couples architecture boundaries and makes their public contracts mutually recursive.",
    "Move shared types to an explicit contract boundary or remove the cyclic type dependency.",
    true
  ),
  runtimeBoundaryImportsDevelopmentBoundary: rule(
    "runtime-boundary-imports-development-boundary",
    "Runtime source cannot depend directly or transitively on a development-only boundary.",
    "Move the shared contract into a runtime boundary or keep the dependency entirely inside development boundaries.",
    true
  ),
  runtimeBoundaryImportsDevelopmentWorkspacePackage: rule(
    "runtime-boundary-imports-development-workspace-package",
    "A workspace package containing development-only source cannot be a proven runtime-only package import target without explicit export ownership evidence.",
    "Move development source to a separate workspace package or import it only from a development boundary.",
    true
  ),
  crossPackageRelativeImport: rule(
    "cross-package-relative-import",
    "Cross-package relative imports bypass package identity and public exports.",
    "Import the target package through an exported package subpath.",
    true
  ),
  crossBoundaryLocalImportNotEntrypoint: rule(
    "cross-boundary-local-import-not-entrypoint",
    "Every cross-boundary local import must use a deliberately declared target entrypoint.",
    "Import the target boundary through one of its declared entrypoint source files.",
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
  invalidBoundaryEntrypoint: rule(
    "invalid-boundary-entrypoint",
    "Boundary entrypoints must resolve to governed source classified by the boundary that declares them.",
    "Correct the entrypoint path or update the boundary classification before relying on it.",
    true
  ),
  packageRuntimeCycle: rule(
    "package-runtime-cycle",
    "A runtime cycle between workspace packages prevents independent package ownership and release ordering.",
    "Break the package cycle with an explicit contract package or directional port.",
    true
  ),
  packageTypeOnlyCycle: rule(
    "package-type-only-cycle",
    "A type-only cycle between workspace packages couples their public type surfaces and release order.",
    "Extract shared types into a directional contract package or remove the cyclic type dependency.",
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
  selfPackageImportBoundaryUnresolved: rule(
    "self-package-import-boundary-unresolved",
    "A package-name import back into the importing workspace package does not reveal the target source boundary.",
    "Use a relative import governed by declared boundary entrypoints, or move the public surface into a separate workspace package.",
    true
  ),
  unsupportedImportSpecifier: rule(
    "unsupported-import-specifier",
    "Unsupported specifiers cannot be classified reliably by the architecture gate.",
    "Use relative, node builtin, declared external, or governed workspace package imports.",
    true
  ),
  uncoveredWorkspacePackageRoot: rule(
    "uncovered-workspace-package-root",
    "Every package selected by the schema v2 packageRoots contract must declare governed source scope.",
    "Add a governed source root and non-overlapping boundary for the package, or remove the package from the workspace glob selection.",
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
> = createUniqueRegistry(
  "rule",
  Object.values(SOURCE_DEPENDENCY_RULES).map((metadata) => [metadata.id, metadata])
);

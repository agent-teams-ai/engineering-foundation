import type { DiagnosticSeverity } from "../../../check-contract.js";
import { createUniqueRegistry } from "../../../unique-registry.js";

export interface RuleMetadata {
  readonly id: string;
  readonly rationale: string;
  readonly severity: DiagnosticSeverity;
  readonly remediation: string;
  readonly documentation: string;
  readonly requiresArchitectureReview: boolean;
}

const documentation =
  "https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/reference/workspace-dependency-declarations.md";

function rule(
  suffix: string,
  rationale: string,
  remediation: string,
  requiresArchitectureReview = false
): RuleMetadata {
  return Object.freeze({
    id: `workspace.dependency-declarations.${suffix}`,
    rationale,
    severity: "error",
    remediation,
    documentation,
    requiresArchitectureReview
  });
}

export const RULES = Object.freeze({
  catalogModeNotStrict: rule(
    "catalog-mode-not-strict",
    "Strict catalog mode prevents undeclared dependency versions from bypassing the central version source.",
    "Set catalogMode: strict in pnpm-workspace.yaml."
  ),
  catalogReferenceMissing: rule(
    "catalog-reference-missing",
    "Every catalog reference must resolve to a declared catalog entry.",
    "Add the dependency to the referenced catalog or correct the catalog reference."
  ),
  catalogVersionNotExact: rule(
    "catalog-version-not-exact",
    "Exact catalog versions keep installs and automated upgrades reproducible.",
    "Replace the catalog range or tag with an exact semantic version."
  ),
  dependencyDeclaredMultipleTimes: rule(
    "dependency-declared-multiple-times",
    "A package dependency must have one unambiguous dependency role.",
    "Keep the dependency in exactly one dependency section."
  ),
  developmentOnlyPackageBundled: rule(
    "development-only-package-bundled",
    "Engineering tooling must never be bundled into production artifacts.",
    "Remove the development-only package from bundleDependencies and bundledDependencies."
  ),
  developmentOnlyPackageInRuntimeSection: rule(
    "development-only-package-in-runtime-section",
    "Engineering tooling is a development dependency and cannot become a production runtime dependency.",
    "Move the package to devDependencies and remove all runtime declarations."
  ),
  exactRegistryDevelopmentOnlyPackageVersionNotExact: rule(
    "exact-registry-development-only-package-version-not-exact",
    "Foundation tooling upgrades must be explicit and reviewable.",
    "Pin the development-only package to an exact registry version."
  ),
  duplicateWorkspacePackageName: rule(
    "duplicate-workspace-package-name",
    "Workspace package names are stable identities and must be unique.",
    "Rename one package and update its consumers.",
    true
  ),
  externalVersionNotCataloged: rule(
    "external-version-not-cataloged",
    "External dependency versions belong to the workspace catalog.",
    "Move the exact version to pnpm-workspace.yaml and use catalog: in package.json."
  ),
  internalDependencyWithoutWorkspaceProtocol: rule(
    "internal-dependency-without-workspace-protocol",
    "The workspace protocol proves that an internal dependency resolves to a local package.",
    "Use a workspace: specifier for the internal package dependency."
  ),
  packageManagerNotExact: rule(
    "package-manager-not-exact",
    "An exact package-manager version keeps workspace semantics reproducible.",
    "Pin packageManager to an exact pnpm semantic version."
  ),
  reservedScopePackageNotInWorkspace: rule(
    "reserved-scope-package-not-in-workspace",
    "A reserved organization scope cannot silently resolve to an unrelated registry package.",
    "Add the package to this workspace or remove the reserved-scope dependency.",
    true
  ),
  workspacePackageNameMissing: rule(
    "workspace-package-name-missing",
    "Every workspace package needs a stable package identity.",
    "Add a non-empty name to the package manifest."
  )
});

export const RULES_BY_ID: ReadonlyMap<string, RuleMetadata> =
  createUniqueRegistry(
    "rule",
    Object.values(RULES).map((metadata) => [metadata.id, metadata])
  );

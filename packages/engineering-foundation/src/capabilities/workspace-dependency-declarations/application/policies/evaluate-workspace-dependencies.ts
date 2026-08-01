import type {
  DiagnosticEvidence,
  FoundationDiagnostic
} from "../../../../check-contract.js";
import { isExactVersion } from "../../../../semantic-version.js";
import type { WorkspaceDependencyPolicy } from "../model/workspace-dependency-policy.js";
import type {
  DependencyDeclaration,
  WorkspaceSnapshot
} from "../model/workspace-snapshot.js";
import { RULES, type RuleMetadata } from "../rules.js";

function diagnostic(input: {
  readonly rule: RuleMetadata;
  readonly subject: string;
  readonly message: string;
  readonly path: string;
  readonly evidence?: readonly DiagnosticEvidence[];
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations: [],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function declarationSubject(declaration: DependencyDeclaration): string {
  return `${declaration.packageName}:${declaration.section}:${declaration.dependencyName}`;
}

function catalogName(specifier: string): string | undefined {
  if (specifier === "catalog:") {
    return "default";
  }
  if (specifier.startsWith("catalog:") && specifier.length > "catalog:".length) {
    return specifier.slice("catalog:".length);
  }
  return undefined;
}

function isReservedPackage(name: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => name.startsWith(scope));
}

function evaluateCatalogs(snapshot: WorkspaceSnapshot): FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  if (snapshot.catalogMode !== "strict") {
    diagnostics.push(
      diagnostic({
        rule: RULES.catalogModeNotStrict,
        subject: "pnpm-workspace:catalogMode",
        message: "pnpm workspace catalogMode must be strict.",
        path: "pnpm-workspace.yaml",
        evidence: [
          { kind: "actual", value: snapshot.catalogMode ?? "missing" }
        ]
      })
    );
  }
  for (const entry of snapshot.catalogs) {
    if (!isExactVersion(entry.version)) {
      diagnostics.push(
        diagnostic({
          rule: RULES.catalogVersionNotExact,
          subject: `catalog:${entry.catalogName}:${entry.dependencyName}`,
          message: `Catalog dependency ${entry.dependencyName} must use an exact version.`,
          path: "pnpm-workspace.yaml",
          evidence: [{ kind: "specifier", value: entry.version }]
        })
      );
    }
  }
  return diagnostics;
}

function evaluatePackageManager(snapshot: WorkspaceSnapshot): FoundationDiagnostic[] {
  const root = snapshot.packages.find((entry) => entry.manifestPath === "package.json");
  const packageManager = root?.packageManager;
  if (
    packageManager === undefined ||
    !packageManager.startsWith("pnpm@") ||
    !isExactVersion(packageManager.slice("pnpm@".length))
  ) {
    return [
      diagnostic({
        rule: RULES.packageManagerNotExact,
        subject: "workspace-root:packageManager",
        message: "The workspace root must pin an exact pnpm version.",
        path: "package.json",
        evidence: [{ kind: "actual", value: packageManager ?? "missing" }]
      })
    ];
  }
  return [];
}

function evaluatePackageNames(snapshot: WorkspaceSnapshot): FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const byName = new Map<string, string[]>();
  for (const workspacePackage of snapshot.packages) {
    if (workspacePackage.name.startsWith("<unnamed:")) {
      diagnostics.push(
        diagnostic({
          rule: RULES.workspacePackageNameMissing,
          subject: workspacePackage.manifestPath,
          message: "Workspace package manifest must declare a package name.",
          path: workspacePackage.manifestPath
        })
      );
      continue;
    }
    const paths = byName.get(workspacePackage.name) ?? [];
    paths.push(workspacePackage.manifestPath);
    byName.set(workspacePackage.name, paths);
  }
  for (const [name, paths] of byName) {
    if (paths.length > 1) {
      diagnostics.push(
        diagnostic({
          rule: RULES.duplicateWorkspacePackageName,
          subject: name,
          message: `Workspace package name ${name} is declared by multiple manifests.`,
          path: paths.toSorted()[0] ?? "package.json",
          evidence: [{ kind: "manifest-paths", value: paths.toSorted().join(", ") }]
        })
      );
    }
  }
  return diagnostics;
}

function evaluateDeclarations(
  snapshot: WorkspaceSnapshot,
  policy: WorkspaceDependencyPolicy
): FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const workspaceNames = new Set(
    snapshot.packages
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("<unnamed:"))
  );
  const devOnly = new Set(policy.developmentOnlyPackages);
  const exactRegistryDevOnly = new Set(
    policy.exactRegistryDevelopmentOnlyPackages
  );
  const allDevOnly = new Set([...devOnly, ...exactRegistryDevOnly]);
  const catalogKeys = new Set(
    snapshot.catalogs.map(
      (entry) => `${entry.catalogName}\u0000${entry.dependencyName}`
    )
  );

  for (const workspacePackage of snapshot.packages) {
    const grouped = Map.groupBy(
      workspacePackage.dependencies,
      (declaration) => declaration.dependencyName
    );
    for (const [dependencyName, declarations] of grouped) {
      if (declarations.length > 1) {
        diagnostics.push(
          diagnostic({
            rule: RULES.dependencyDeclaredMultipleTimes,
            subject: `${workspacePackage.name}:${dependencyName}`,
            message: `Dependency ${dependencyName} is declared in multiple dependency sections.`,
            path: workspacePackage.manifestPath,
            evidence: [
              {
                kind: "sections",
                value: declarations.map((entry) => entry.section).toSorted().join(", ")
              }
            ]
          })
        );
      }
    }

    for (const dependency of workspacePackage.dependencies) {
      const subject = declarationSubject(dependency);
      if (allDevOnly.has(dependency.dependencyName)) {
        if (dependency.section !== "devDependencies") {
          diagnostics.push(
            diagnostic({
              rule: RULES.developmentOnlyPackageInRuntimeSection,
              subject,
              message: `Development-only package ${dependency.dependencyName} cannot be declared in ${dependency.section}.`,
              path: dependency.manifestPath
            })
          );
        }
        if (
          exactRegistryDevOnly.has(dependency.dependencyName) &&
          !isExactVersion(dependency.specifier)
        ) {
          diagnostics.push(
            diagnostic({
              rule: RULES.exactRegistryDevelopmentOnlyPackageVersionNotExact,
              subject,
              message: `Development-only package ${dependency.dependencyName} must use an exact registry version.`,
              path: dependency.manifestPath,
              evidence: [{ kind: "specifier", value: dependency.specifier }]
            })
          );
        }
        if (exactRegistryDevOnly.has(dependency.dependencyName)) {
          continue;
        }
      }

      if (workspaceNames.has(dependency.dependencyName)) {
        if (!dependency.specifier.startsWith("workspace:")) {
          diagnostics.push(
            diagnostic({
              rule: RULES.internalDependencyWithoutWorkspaceProtocol,
              subject,
              message: `Internal dependency ${dependency.dependencyName} must use the workspace protocol.`,
              path: dependency.manifestPath,
              evidence: [{ kind: "specifier", value: dependency.specifier }]
            })
          );
        }
        continue;
      }

      if (
        isReservedPackage(
          dependency.dependencyName,
          policy.reservedScopes
        )
      ) {
        diagnostics.push(
          diagnostic({
            rule: RULES.reservedScopePackageNotInWorkspace,
            subject,
            message: `Reserved-scope dependency ${dependency.dependencyName} is not a workspace package.`,
            path: dependency.manifestPath
          })
        );
        continue;
      }

      const referencedCatalog = catalogName(dependency.specifier);
      if (referencedCatalog === undefined) {
        diagnostics.push(
          diagnostic({
            rule: RULES.externalVersionNotCataloged,
            subject,
            message: `External dependency ${dependency.dependencyName} must use a catalog reference.`,
            path: dependency.manifestPath,
            evidence: [{ kind: "specifier", value: dependency.specifier }]
          })
        );
      } else if (
        !catalogKeys.has(`${referencedCatalog}\u0000${dependency.dependencyName}`)
      ) {
        diagnostics.push(
          diagnostic({
            rule: RULES.catalogReferenceMissing,
            subject,
            message: `Catalog ${referencedCatalog} does not declare ${dependency.dependencyName}.`,
            path: dependency.manifestPath,
            evidence: [{ kind: "catalog", value: referencedCatalog }]
          })
        );
      }
    }

    for (const packageName of workspacePackage.bundledDependencies) {
      if (allDevOnly.has(packageName)) {
        diagnostics.push(
          diagnostic({
            rule: RULES.developmentOnlyPackageBundled,
            subject: `${workspacePackage.name}:bundle:${packageName}`,
            message: `Development-only package ${packageName} cannot be bundled.`,
            path: workspacePackage.manifestPath
          })
        );
      }
    }
  }
  return diagnostics;
}

export function evaluateWorkspaceDependencies(
  snapshot: WorkspaceSnapshot,
  policy: WorkspaceDependencyPolicy
): readonly FoundationDiagnostic[] {
  return [
    ...evaluateCatalogs(snapshot),
    ...evaluatePackageManager(snapshot),
    ...evaluatePackageNames(snapshot),
    ...evaluateDeclarations(snapshot, policy)
  ];
}

import { CapabilityInputError, assertNotCancelled } from "../../../features/validation-reporting/api.js";

export function assertWorkspaceReadActive(signal?: AbortSignal): void {
  assertNotCancelled(signal);
}

export function manifestObjectRequired(manifestPath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_MANIFEST_INVALID",
    message: `Workspace package manifest must contain an object: ${manifestPath}.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function manifestUnstable(manifestPath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_MANIFEST_INVALID",
    message: `Workspace package manifest changed, escaped containment, or is not stable valid JSON: ${manifestPath}.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function manifestEscape(manifestPath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_MANIFEST_ESCAPE",
    message: `Workspace package manifest escapes the consumer repository: ${manifestPath}.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function manifestUnavailable(manifestPath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_MANIFEST_UNAVAILABLE",
    message: `Workspace package manifest is unavailable: ${manifestPath}.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function manifestSymlink(manifestPath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_MANIFEST_SYMLINK_PROHIBITED",
    message: `Workspace package manifests cannot be symbolic links: ${manifestPath}.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function invalidExportSubpath(manifestPath: string, subpath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_EXPORTS_INVALID",
    message: `${manifestPath} contains an invalid export subpath: ${subpath}.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function mixedExportSubpaths(manifestPath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_EXPORTS_INVALID",
    message: `${manifestPath} exports cannot mix subpaths and conditions at the same level.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function invalidExportTarget(field: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_EXPORTS_INVALID",
    message: `${field} export target must be a string, null, array, or condition object.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function invalidExportCondition(field: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_EXPORTS_INVALID",
    message: `${field} conditional export target is invalid.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function exportBudgetExceeded(field: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_EXPORTS_INVALID",
    message: `${field} export target exceeds the bounded structure budget.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function packageNamesArrayRequired(field: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_MANIFEST_INVALID",
    message: `${field} must be an array of package names.`,
    phase: "package-manifest",
    retryable: false
  });
}

export function workspaceStringValuesRequired(field: string, phase: string): never {
  throw new CapabilityInputError({
    code: "GOVERNED_INPUT_INVALID",
    message: `${field} must contain non-empty string values.`,
    phase,
    retryable: false
  });
}

export function workspaceStringRecordRequired(field: string, phase: string): never {
  throw new CapabilityInputError({
    code: "GOVERNED_INPUT_INVALID",
    message: `${field} must be an object.`,
    phase,
    retryable: false
  });
}

export function workspaceManifestObjectRequired(): never {
  throw new CapabilityInputError({
    code: "PNPM_WORKSPACE_INVALID",
    message: "pnpm-workspace.yaml must contain an object.",
    phase: "workspace-manifest",
    retryable: false
  });
}

export function duplicateDefaultCatalog(): never {
  throw new CapabilityInputError({
    code: "PNPM_WORKSPACE_INVALID",
    message: "The default catalog must use either catalog or catalogs.default, not both.",
    phase: "workspace-manifest",
    retryable: false
  });
}

export function manifestPathCollision(existing: string, manifestPath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_PATH_CASE_COLLISION",
    message: `Workspace package paths differ only by letter case: ${existing} and ${manifestPath}.`,
    phase: "workspace-discovery",
    retryable: false
  });
}

export function workspacePackageLimitExceeded(maximum: number): never {
  throw new CapabilityInputError({
    code: "WORKSPACE_LIMIT_EXCEEDED",
    message: `Workspace contains more than ${maximum} package manifests.`,
    phase: "workspace-discovery",
    retryable: false
  });
}

export function workspaceDiscoveryLimitExceeded(maximum: number): never {
  throw new CapabilityInputError({
    code: "WORKSPACE_DISCOVERY_LIMIT_EXCEEDED",
    message: `Workspace discovery exceeds ${maximum} filesystem entries.`,
    phase: "workspace-discovery",
    retryable: false
  });
}

export function workspaceDirectoryUnavailable(repositoryPath: string): never {
  throw new CapabilityInputError({
    code: "WORKSPACE_DISCOVERY_UNAVAILABLE",
    message: `Workspace discovery could not inspect ${repositoryPath}.`,
    phase: "workspace-discovery",
    retryable: false
  });
}

export function unsafeDirectoryEntry(): never {
  throw new CapabilityInputError({
    code: "WORKSPACE_GLOB_CANDIDATE_INVALID",
    message: "Workspace discovery returned an unsafe directory entry.",
    phase: "workspace-discovery",
    retryable: false
  });
}

export function workspaceCatalogsInvalid(): never {
  throw new CapabilityInputError({
    code: "PNPM_WORKSPACE_INVALID",
    message: "catalogs must be an object.",
    phase: "workspace-manifest",
    retryable: false
  });
}

export function workspacePatternsInvalid(): never {
  throw new CapabilityInputError({
    code: "PNPM_WORKSPACE_INVALID",
    message: "pnpm-workspace.yaml packages must contain repository-relative POSIX glob patterns.",
    phase: "workspace-discovery",
    retryable: false
  });
}

export function directoryPathCollision(existing: string, repositoryPath: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_PATH_CASE_COLLISION",
    message: `Workspace package directories differ only by portable identity: ${existing} and ${repositoryPath}.`,
    phase: "workspace-discovery",
    retryable: false
  });
}

export function patternPathCollision(literalPath: string, discovered: string): never {
  throw new CapabilityInputError({
    code: "PACKAGE_PATH_CASE_COLLISION",
    message: `Workspace pattern and package directory paths differ only by portable identity: ${literalPath} and ${discovered}.`,
    phase: "workspace-discovery",
    retryable: false
  });
}

export function workspaceCandidateInvalid(): never {
  throw new CapabilityInputError({
    code: "WORKSPACE_GLOB_CANDIDATE_INVALID",
    message: "Workspace discovery returned a non-contained package manifest candidate.",
    phase: "workspace-discovery",
    retryable: false
  });
}

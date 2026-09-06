export type ReleaseBump = "major" | "minor" | "patch";

export type PublicApiCompatibilityConfigSchemaVersion = 1;

export interface PublicApiItem {
  readonly canonicalReference: string;
  readonly kind: string;
  readonly parentReference?: string;
  readonly parentKind: string;
  readonly signature: string;
}

export function compareCanonicalReferences(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One release-owned anchor contains every typed package export. */
export function publicApiBaselineAnchorPath(packageName: string): string {
  const localName = packageName.slice(packageName.lastIndexOf("/") + 1);
  return `architecture/public-api/${localName}.json`;
}

export function publicApiArtifactBaselineAnchorPath(packageName: string): string {
  return publicApiBaselineAnchorPath(packageName).replace(/\.json$/u, ".artifacts.json");
}

export interface PublicApiEntrypointPolicy {
  /** Package export key, for example `.` or `./local-mode`. */
  readonly exportPath: string;
  readonly declarationEntryPoint: string;
}

export type PublicApiNonTypeExportKind = "data" | "runtime" | "wildcard";

export interface PublicApiNonTypeExportPolicy {
  readonly exportPath: string;
  readonly kind: PublicApiNonTypeExportKind;
}

export type PublicApiArtifactBaselineStatus = "historical-bootstrap" | "initial-unreleased" | "release-candidate" | "supported";

export interface PublicApiWildcardExportSnapshot {
  readonly exportPath: string;
  readonly targetPattern: string;
  readonly members: readonly string[];
}

export interface PublicApiJsonSchemaSnapshot {
  readonly path: string;
  readonly id: string;
  readonly digest: `sha256:${string}`;
  readonly discriminators: Readonly<Record<string, unknown>>;
}

/** Release-owned evidence for concrete members hidden behind wildcard exports. */
export interface PublicApiArtifactSnapshot {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly status: PublicApiArtifactBaselineStatus;
  readonly wildcardExports: readonly PublicApiWildcardExportSnapshot[];
  readonly jsonSchemas: readonly PublicApiJsonSchemaSnapshot[];
  /** Retained exact archive evidence for explicit initial fixation. */
  readonly archive?: {
    readonly sha256: `sha256:${string}`;
    readonly integrity: string;
    readonly manifestDigest: `sha256:${string}`;
    readonly sourceCommit: string;
    readonly memberDigests: readonly { readonly path: string; readonly digest: `sha256:${string}` }[];
  };
}

export interface ApprovedBreakingChange {
  readonly fingerprint: string;
  readonly decisionId: `ADR-${string}`;
}

export interface PublicApiPackagePolicy {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly tsconfigPath: string;
  readonly releasedBaselinePath: string;
  readonly approvedBreakingChanges: readonly ApprovedBreakingChange[];
  readonly entrypoints: readonly PublicApiEntrypointPolicy[];
  readonly nonTypeExports: readonly PublicApiNonTypeExportPolicy[];
}

export interface PublicApiCompatibilityPolicy {
  readonly schemaVersion: 1;
  readonly acceptedDecisionBaselinePath: string;
  /** Needed only when this policy declares a breaking-change approval. */
  readonly governanceConfigPath?: string;
  readonly changesetDirectory: string;
  readonly packages: readonly PublicApiPackagePolicy[];
}

export function publicApiPolicySchemaVersion(
  _policy: PublicApiCompatibilityPolicy
): PublicApiCompatibilityConfigSchemaVersion {
  return 1;
}

export interface PublicApiEntrypointSnapshot {
  readonly exportPath: string;
  readonly items: readonly PublicApiItem[];
}

export interface PublicApiSnapshot {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly extractorVersion: string;
  readonly entrypoints: readonly PublicApiEntrypointSnapshot[];
}

export function approvedBreakingChangeReference(
  approval: ApprovedBreakingChange
): string {
  return approval.decisionId;
}

export function publicApiEntrypoints(
  policy: PublicApiPackagePolicy
): readonly PublicApiEntrypointPolicy[] {
  return policy.entrypoints;
}

export function publicApiDeclarationEntryPoint(
  policy: PublicApiPackagePolicy
): string {
  const entrypoint = policy.entrypoints[0];
  if (entrypoint === undefined) {
    throw new Error(`Public API package ${policy.packageName} has no entry points.`);
  }
  return entrypoint.declarationEntryPoint;
}

export function publicApiSnapshotEntrypoints(
  snapshot: PublicApiSnapshot
): readonly PublicApiEntrypointSnapshot[] {
  return snapshot.entrypoints;
}

export interface PublicApiEntrypointItemReference {
  readonly exportPath: string;
  readonly canonicalReference: string;
}

export interface PublicApiChangeSet {
  readonly schemaVersion: 1;
  readonly classification: "additive" | "breaking" | "none";
  readonly fingerprint?: string;
  readonly addedEntrypoints: readonly string[];
  readonly removedEntrypoints: readonly string[];
  readonly added: readonly PublicApiEntrypointItemReference[];
  readonly changed: readonly PublicApiEntrypointItemReference[];
  readonly removed: readonly PublicApiEntrypointItemReference[];
}

export interface PackageReleaseEvidence {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly declaredBump?: ReleaseBump;
  readonly prereleaseInitialVersion?: string;
  readonly prereleaseTag?: string;
}

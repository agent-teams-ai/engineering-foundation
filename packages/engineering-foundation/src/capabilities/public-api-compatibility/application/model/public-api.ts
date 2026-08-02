export type ReleaseBump = "major" | "minor" | "patch";

export type PublicApiCompatibilityConfigSchemaVersion = 1 | 2;

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

/**
 * A package has one release-owned baseline anchor. Schema v2 keeps all public
 * subpaths in that one baseline, scoped by export path, instead of allowing a
 * mutable policy to redirect evidence to another file.
 */
export function publicApiBaselineAnchorPath(packageName: string): string {
  const localName = packageName.slice(packageName.lastIndexOf("/") + 1);
  return `architecture/public-api/${localName}.json`;
}

export interface PublicApiEntrypointPolicy {
  /** Package export key, for example `.` or `./local-mode`. */
  readonly exportPath: string;
  readonly declarationEntryPoint: string;
}

/**
 * A public package export that cannot be represented by a declaration entry
 * point. Schema v2 requires these to be named explicitly instead of silently
 * falling outside compatibility governance.
 */
export type PublicApiNonTypeExportKind = "data" | "runtime" | "wildcard";

export interface PublicApiNonTypeExportPolicy {
  readonly exportPath: string;
  readonly kind: PublicApiNonTypeExportKind;
}

interface PublicApiPackagePolicyBase {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly tsconfigPath: string;
  readonly releasedBaselinePath: string;
  readonly approvedBreakingChanges: readonly ApprovedBreakingChange[];
}

/** Configuration schema v1 retains one declaration entry point per package. */
interface PublicApiPackagePolicyV1 extends PublicApiPackagePolicyBase {
  readonly declarationEntryPoint: string;
}

/** Configuration schema v2 scopes every declaration entry point by export path. */
interface PublicApiPackagePolicyV2 extends PublicApiPackagePolicyBase {
  readonly entrypoints: readonly PublicApiEntrypointPolicy[];
  readonly nonTypeExports: readonly PublicApiNonTypeExportPolicy[];
}

export type PublicApiPackagePolicy =
  | PublicApiPackagePolicyV1
  | PublicApiPackagePolicyV2;

interface PublicApiCompatibilityPolicyV1 {
  /** Omitted only by legacy programmatic callers; config files always declare 1. */
  readonly schemaVersion?: 1;
  /** Required when a v1 package declares a breaking-change approval. */
  readonly acceptedDecisionBaselinePath?: string;
  readonly changesetDirectory: string;
  readonly packages: readonly PublicApiPackagePolicyV1[];
}

interface PublicApiCompatibilityPolicyV2 {
  readonly schemaVersion: 2;
  readonly acceptedDecisionBaselinePath: string;
  readonly changesetDirectory: string;
  readonly packages: readonly PublicApiPackagePolicyV2[];
}

export type PublicApiCompatibilityPolicy =
  | PublicApiCompatibilityPolicyV1
  | PublicApiCompatibilityPolicyV2;

export function publicApiPolicySchemaVersion(
  policy: PublicApiCompatibilityPolicy
): PublicApiCompatibilityConfigSchemaVersion {
  return policy.schemaVersion ?? 1;
}

interface PublicApiSnapshotV1 {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly extractorVersion: string;
  readonly items: readonly PublicApiItem[];
}

export interface PublicApiEntrypointSnapshot {
  readonly exportPath: string;
  readonly items: readonly PublicApiItem[];
}

interface PublicApiSnapshotV2 {
  readonly schemaVersion: 2;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly extractorVersion: string;
  readonly entrypoints: readonly PublicApiEntrypointSnapshot[];
}

export type PublicApiSnapshot = PublicApiSnapshotV1 | PublicApiSnapshotV2;

export interface ApprovedBreakingChange {
  readonly fingerprint: string;
  readonly decisionPath: string;
}

export function publicApiEntrypoints(
  policy: PublicApiPackagePolicy
): readonly PublicApiEntrypointPolicy[] {
  if ("entrypoints" in policy) {
    return policy.entrypoints;
  }
  return Object.freeze([
    Object.freeze({
      exportPath: ".",
      declarationEntryPoint: policy.declarationEntryPoint
    })
  ]);
}

export function publicApiDeclarationEntryPoint(
  policy: PublicApiPackagePolicy
): string {
  const entrypoint = publicApiEntrypoints(policy)[0];
  if (entrypoint === undefined) {
    throw new Error(`Public API package ${policy.packageName} has no entry points.`);
  }
  return entrypoint.declarationEntryPoint;
}

export function publicApiSnapshotEntrypoints(
  snapshot: PublicApiSnapshot
): readonly PublicApiEntrypointSnapshot[] {
  if (snapshot.schemaVersion === 2) {
    return snapshot.entrypoints;
  }
  return Object.freeze([
    Object.freeze({ exportPath: ".", items: snapshot.items })
  ]);
}

interface PublicApiChangeSetBase {
  readonly classification: "additive" | "breaking" | "none";
  readonly fingerprint?: string;
}

export interface PublicApiChangeSetV1 extends PublicApiChangeSetBase {
  readonly schemaVersion: 1;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

export interface PublicApiEntrypointItemReference {
  readonly exportPath: string;
  readonly canonicalReference: string;
}

export interface PublicApiChangeSetV2 extends PublicApiChangeSetBase {
  readonly schemaVersion: 2;
  readonly addedEntrypoints: readonly string[];
  readonly removedEntrypoints: readonly string[];
  readonly added: readonly PublicApiEntrypointItemReference[];
  readonly changed: readonly PublicApiEntrypointItemReference[];
  readonly removed: readonly PublicApiEntrypointItemReference[];
}

export type PublicApiChangeSet = PublicApiChangeSetV1 | PublicApiChangeSetV2;

export interface PackageReleaseEvidence {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly declaredBump?: ReleaseBump;
}

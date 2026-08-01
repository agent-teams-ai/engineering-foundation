export type ReleaseBump = "major" | "minor" | "patch";

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

export interface PublicApiSnapshot {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly extractorVersion: string;
  readonly items: readonly PublicApiItem[];
}

export interface ApprovedBreakingChange {
  readonly fingerprint: string;
  readonly decisionPath: string;
}

export interface PublicApiPackagePolicy {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly declarationEntryPoint: string;
  readonly tsconfigPath: string;
  readonly releasedBaselinePath: string;
  readonly approvedBreakingChanges: readonly ApprovedBreakingChange[];
}

export interface PublicApiCompatibilityPolicy {
  readonly changesetDirectory: string;
  readonly packages: readonly PublicApiPackagePolicy[];
}

export interface PublicApiChangeSet {
  readonly classification: "additive" | "breaking" | "none";
  readonly fingerprint?: string;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

export interface PackageReleaseEvidence {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly declaredBump?: ReleaseBump;
}

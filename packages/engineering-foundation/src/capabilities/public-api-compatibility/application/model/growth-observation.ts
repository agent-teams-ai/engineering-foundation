import type { PublicApiSnapshot } from "./public-api.js";

export type GrowthDigest = `sha256:${string}`;
export type GrowthEvidence<T> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly reasons: readonly string[] };
export interface GrowthInvocation {
  readonly repository: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly topologyDigest: GrowthDigest;
  readonly lockDigest: GrowthDigest;
  readonly toolchainDigest: GrowthDigest;
  readonly artifactDigests: readonly GrowthDigest[];
  readonly tool: { readonly version: string; readonly artifactDigest: GrowthDigest; readonly extractorVersion: string };
}
export interface GrowthCancellation {
  readonly signal?: AbortSignal;
  throwIfCancelled(): void;
}
export type GrowthResolutionStep =
  | { readonly condition: string }
  | { readonly index: number };
export type GrowthResolutionTree =
  | { readonly kind: "target"; readonly target: string }
  | { readonly kind: "null" }
  | { readonly kind: "conditions"; readonly entries: readonly { readonly condition: string; readonly value: GrowthResolutionTree }[] }
  | { readonly kind: "fallbacks"; readonly entries: readonly GrowthResolutionTree[] };
export interface GrowthCoordinate {
  readonly packageName: string;
  readonly exportPath: string;
  readonly resolutionBranch: readonly GrowthResolutionStep[];
  readonly subject:
    | { readonly kind: "typed"; readonly canonicalReference: string }
    | { readonly kind: "export-branch" }
    | { readonly kind: "bin"; readonly name: string }
    | { readonly kind: "data" | "wildcard-member"; readonly member: string }
    | { readonly kind: "package" };
}
export const growthDimensions = ["topology", "resolution", "typed", "reachable", "runtime", "bin", "data", "wildcard", "packed", "decision"] as const;
export interface GrowthCoverage {
  readonly packageName: string;
  readonly classification: "governed" | "private-only";
  readonly dimensions: readonly {
    readonly dimension: typeof growthDimensions[number];
    readonly status: "complete" | "limited" | "unsupported" | "unavailable";
    readonly reasons: readonly string[];
  }[];
}
export interface GrowthSurfaceObservation extends GrowthInvocation {
  readonly contractRevision: "foundation:sdk-growth:c0:5";
  readonly observationVersion: "foundation:sdk-growth:observation:1";
  readonly coverage: readonly GrowthCoverage[];
  readonly entries: readonly {
    readonly coordinate: GrowthCoordinate;
    readonly value: { readonly state: "absent" } | { readonly state: "present"; readonly digest: GrowthDigest };
  }[];
}
export interface GrowthCompatibilityPackage {
  readonly packageName: string;
  readonly typed: { readonly kind: "typed"; readonly snapshot: GrowthEvidence<PublicApiSnapshot> };
  readonly artifact: { readonly kind: "artifact"; readonly snapshot: GrowthEvidence<PublicApiSnapshot> };
}
export interface GrowthObservationExecution {
  readonly identity: GrowthInvocation;
  readonly surface: GrowthEvidence<GrowthSurfaceObservation>;
  readonly compatibilitySnapshots: readonly GrowthCompatibilityPackage[];
}

export class GrowthObservationInvariantError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "GrowthObservationInvariantError";
  }
}

/** Expected observation limits retain compatibility evidence but no growth equality. */
export class GrowthObservationUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "GrowthObservationUnavailableError";
  }
}

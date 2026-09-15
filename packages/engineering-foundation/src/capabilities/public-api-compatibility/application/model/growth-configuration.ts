import type { PublicApiCompatibilityPolicy } from "./public-api.js";
import type { GrowthContextRequest } from "./growth-admission-context.js";
import type { GrowthDigest, GrowthInvocation } from "./growth-observation.js";

/** Explicit opt-in. Compatibility retains the unchanged v1 policy and mapper. */
export interface SdkGrowthCapabilityPolicy {
  readonly schemaVersion: 2;
  readonly compatibility: PublicApiCompatibilityPolicy;
  readonly sdkGrowth: {
    readonly workspaceManifestPath: string;
    readonly invocation: GrowthInvocation;
    readonly context: GrowthContextRequest;
    readonly report: { readonly path: string; readonly expectedPreimage: GrowthDigest | null };
  };
}
export type PublicApiCapabilityPolicy = PublicApiCompatibilityPolicy | SdkGrowthCapabilityPolicy;

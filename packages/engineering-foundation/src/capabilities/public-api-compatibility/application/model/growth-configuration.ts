import type { PublicApiCompatibilityPolicy } from "./public-api.js";
import type { GrowthContextRequest } from "./growth-admission-context.js";

/** Closed frozen configuration. Execution identity belongs to composition. */
export interface SdkGrowthCapabilityPolicy {
  readonly schemaVersion: 2;
  readonly compatibility: PublicApiCompatibilityPolicy;
  readonly sdkGrowth: {
    readonly contractRevision: "foundation:sdk-growth:c0:5";
    readonly policyVersion: "foundation:sdk-growth:policy:1";
    readonly comparison: Omit<GrowthContextRequest, "decisionsPath">;
    readonly decisionsPath: string;
    readonly reportPath: string;
  };
}
export type PublicApiCapabilityPolicy = PublicApiCompatibilityPolicy | SdkGrowthCapabilityPolicy;

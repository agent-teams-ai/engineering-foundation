export type {
  GrowthAuthorityBinding,
  GrowthAuthorityCompletion,
  GrowthAuthorityGrant,
  GrowthAuthorityMetadataRoot,
  GrowthMetadataRootSource,
  GrowthAuthorityOwnerEvidence,
  GrowthAuthorityPackedEvidence,
  GrowthAuthoritySource,
  GrowthAuthorityReceipt,
  GrowthAuthorityRequest,
  GrowthPromotionPlan
} from "../../../application/model/growth-authority.js";

/** ReviewRouter supplies this executable transport from trusted composition.
 * Candidate configuration cannot select, import or replace it. */
export interface SdkGrowthAuthorityTransport {
  resolve(request: unknown, signal?: AbortSignal): Promise<string | Uint8Array>;
  complete(completion: unknown, signal?: AbortSignal): Promise<string | Uint8Array>;
}

export type { GrowthInstalledInventoryReader } from "../../../application/ports/growth-authority.js";

export type {
  growthDimensions,
  GrowthCancellation,
  GrowthCoordinate,
  GrowthCoverage,
  GrowthDigest,
  GrowthInvocation,
  GrowthResolutionStep,
  GrowthSurfaceObservation
} from "../../../application/model/growth-observation.js";

export type {
  GrowthAuthorityBinding,
  GrowthAuthorityCompletion,
  GrowthAuthorityGrant,
  GrowthAuthorityOwnerEvidence,
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

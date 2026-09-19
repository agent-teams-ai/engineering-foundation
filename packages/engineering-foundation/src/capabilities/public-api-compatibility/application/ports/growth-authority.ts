import type { GrowthAuthorityCompletion, GrowthAuthorityGrant, GrowthAuthorityReceipt, GrowthAuthorityRequest } from "../model/growth-authority.js";
import type { GrowthCancellation } from "../model/growth-observation.js";

export interface GrowthAuthorityPort {
  resolve(request: GrowthAuthorityRequest, cancellation: GrowthCancellation): Promise<GrowthAuthorityGrant>;
  complete(completion: GrowthAuthorityCompletion, cancellation: GrowthCancellation): Promise<GrowthAuthorityReceipt>;
}

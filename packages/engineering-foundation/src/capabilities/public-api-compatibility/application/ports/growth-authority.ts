import type { GrowthAuthorityPackedEvidence, GrowthAuthorityCompletion, GrowthAuthorityGrant, GrowthAuthorityReceipt, GrowthAuthorityRequest } from "../model/growth-authority.js";
import type { GrowthCancellation } from "../model/growth-observation.js";

export interface GrowthAuthorityPort {
  resolve(request: GrowthAuthorityRequest, cancellation: GrowthCancellation): Promise<GrowthAuthorityGrant>;
  complete(completion: GrowthAuthorityCompletion, cancellation: GrowthCancellation): Promise<GrowthAuthorityReceipt>;
}

/** Supplied only by trusted composition, independently of serialized grants.
 * Implementations read the complete installed package tree selected by immutable
 * custody identity, rejecting links and non-regular members. No grant inventory
 * or payload is supplied to this reader. */
export interface GrowthInstalledInventoryReader {
  read(identity: Pick<GrowthAuthorityPackedEvidence, "packageName" | "packageVersion" | "archiveDigest" | "archiveIntegrity" | "source">,
    cancellation: GrowthCancellation): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]>;
}

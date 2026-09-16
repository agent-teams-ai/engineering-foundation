import type { SdkGrowthAuthorityTransport } from "../../../adapters/inbound/authority/growth-authority-contract.js";
import type { GrowthAuthorityCompletion, GrowthAuthorityRequest } from "../../../application/model/growth-authority.js";
import type { GrowthCancellation } from "../../../application/model/growth-observation.js";
import type { GrowthAuthorityPort } from "../../../application/ports/growth-authority.js";
import type { ChangeFingerprint } from "../../../application/ports/change-fingerprint.js";
import { validateGrowthAuthorityGrant, validateGrowthAuthorityReceipt } from "../../../application/policies/validate-growth-authority.js";

/** Anti-corruption boundary for ReviewRouter-owned authenticated transport.
 * Transport values are untrusted until the closed contract and exact bindings
 * are validated here. */
export class ReviewRouterGrowthAuthorityAcl implements GrowthAuthorityPort {
  constructor(
    private readonly transport: SdkGrowthAuthorityTransport,
    private readonly fingerprint: ChangeFingerprint,
    private readonly now: () => Date = () => new Date()
  ) {}

  async resolve(request: GrowthAuthorityRequest, cancellation: GrowthCancellation) {
    cancellation.throwIfCancelled();
    const result = await this.transport.resolve(structuredClone(request), cancellation.signal);
    cancellation.throwIfCancelled();
    return validateGrowthAuthorityGrant(result, request, this.fingerprint, this.now());
  }

  async complete(completion: GrowthAuthorityCompletion, cancellation: GrowthCancellation) {
    cancellation.throwIfCancelled();
    const result = await this.transport.complete(structuredClone(completion), cancellation.signal);
    cancellation.throwIfCancelled();
    return validateGrowthAuthorityReceipt(result, completion, completion.promotion.kind === "none" ? "check" : "promote-release", this.fingerprint);
  }
}

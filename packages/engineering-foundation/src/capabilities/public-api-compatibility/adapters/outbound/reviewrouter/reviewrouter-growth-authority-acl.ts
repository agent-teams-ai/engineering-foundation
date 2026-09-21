import { types } from "node:util";

import type { SdkGrowthAuthorityTransport } from "../../../adapters/inbound/authority/growth-authority-contract.js";
import type { GrowthAuthorityCompletion, GrowthAuthorityRequest } from "../../../application/model/growth-authority.js";
import type { GrowthCancellation } from "../../../application/model/growth-observation.js";
import type { GrowthAuthorityPort, GrowthInstalledInventoryReader } from "../../../application/ports/growth-authority.js";
import type { ChangeFingerprint } from "../../../application/ports/change-fingerprint.js";
import { validateGrowthAuthorityGrant, validateGrowthAuthorityReceipt, validateGrowthInstalledInventory } from "../../../application/policies/validate-growth-authority.js";
import { parseStrictJsonResponse } from "./strict-json-response.js";

const MAX_AUTHORITY_RESPONSE_BYTES = 32 * 1024 * 1024;
const snapshotProxyInspection = Object.freeze({ isProxy: types.isProxy });

function parseResponse(value: string | Uint8Array): unknown {
  // TextDecoder performs an intrinsic buffer-source brand check. Do not inspect
  // properties on an arbitrary transport value before it has crossed the JSON
  // boundary; doing so could execute getters or Proxy traps.
  const text = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  if (new TextEncoder().encode(text).byteLength > MAX_AUTHORITY_RESPONSE_BYTES) {
    throw new TypeError("SDK growth authority response exceeds 32 MiB.");
  }
  return parseStrictJsonResponse(text);
}

/** Anti-corruption boundary for ReviewRouter-owned authenticated transport.
 * Transport values are untrusted until the closed contract and exact bindings
 * are validated here. */
export class ReviewRouterGrowthAuthorityAcl implements GrowthAuthorityPort {
  constructor(
    private readonly transport: SdkGrowthAuthorityTransport,
    private readonly fingerprint: ChangeFingerprint,
    private readonly now: () => Date,
    private readonly installedInventory?: GrowthInstalledInventoryReader
  ) {}

  async resolve(request: GrowthAuthorityRequest, cancellation: GrowthCancellation) {
    cancellation.throwIfCancelled();
    const result = await this.transport.resolve(structuredClone(request), cancellation.signal);
    cancellation.throwIfCancelled();
    const grant = validateGrowthAuthorityGrant(parseResponse(result), request, this.fingerprint, snapshotProxyInspection, this.now());
    for (const packed of [...grant.archives, ...grant.candidates]) {
      const { packageName, packageVersion, archiveDigest, archiveIntegrity, source } = packed;
      const inventory = await this.installedInventory?.read({ packageName, packageVersion, archiveDigest, archiveIntegrity, source }, cancellation);
      cancellation.throwIfCancelled();
      validateGrowthInstalledInventory(packed, inventory, this.fingerprint);
    }
    return grant;
  }

  async complete(completion: GrowthAuthorityCompletion, cancellation: GrowthCancellation) {
    cancellation.throwIfCancelled();
    const result = await this.transport.complete(structuredClone(completion), cancellation.signal);
    // A validated receipt is the committed outcome. A late abort cannot
    // reclassify that acknowledged effect as cancellation.
    return validateGrowthAuthorityReceipt(parseResponse(result), completion, completion.promotion.kind === "none" ? "check" : "promote-release", this.fingerprint);
  }
}

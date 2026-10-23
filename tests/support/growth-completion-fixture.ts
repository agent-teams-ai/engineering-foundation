import assert from "node:assert/strict";
import type {
  GrowthAuthorityRequest,
  GrowthAuthorityGrant,
  GrowthAuthorityCompletion,
  GrowthAuthorityReceipt,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-authority.js";
import {
  growthAuthorityGrantDigest,
  validateGrowthAuthorityReceipt,
  growthAuthorityCompletionDigest,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-authority.js";
import type { GrowthAuthorityFixturePorts } from "./growth-authority-test-ports.ts";
export function growthCompletionFixture({ fingerprint, d }: GrowthAuthorityFixturePorts) {
  const schemaVersion = "reviewrouter:sdk-growth-authority:3";
  function completion(
    req: GrowthAuthorityRequest,
    trustedGrant: GrowthAuthorityGrant,
  ): GrowthAuthorityCompletion {
    return {
      schemaVersion,
      kind: "completion",
      grantId: trustedGrant.grantId,
      grantDigest: growthAuthorityGrantDigest(trustedGrant, fingerprint),
      requestDigest: trustedGrant.requestDigest,
      binding: req.binding,
      reportDigest: d("1"),
      reportByteLength: 100,
      coverageDigest: trustedGrant.requiredCoverageDigest,
      phasesDigest: d("3"),
      verdict: "admitted",
      releaseEligible: true,
      publication: "finalized",
      promotion: { kind: "none" },
    };
  }
  function receipt(
    done: GrowthAuthorityCompletion,
    grantEvidence?: GrowthAuthorityGrant,
  ): GrowthAuthorityReceipt {
    return {
      schemaVersion,
      kind: "receipt",
      receiptId: "receipt-check",
      grantId: done.grantId,
      grantDigest: done.grantDigest,
      requestDigest: done.requestDigest,
      completionDigest: growthAuthorityCompletionDigest(done, fingerprint),
      binding: done.binding,
      reportDigest: done.reportDigest,
      coverageDigest: done.coverageDigest,
      phasesDigest: done.phasesDigest,
      verdict: done.verdict,
      releaseEligible: done.releaseEligible,
      qualification: "qualified",
      operation: "check",
      promotion: done.promotion,
      custodyRef: "reviewrouter/receipts/1",
      issuedAt: "2026-09-16T11:00:00Z",
      ...(grantEvidence === undefined
        ? {}
        : { provenance: { grant: grantEvidence, completion: done } }),
    };
  }

  return { completion, receipt };
}

export function assertFinalAuthorityReceipt(fixtures: GrowthAuthorityFixturePorts): void {
  const { request, grant, validateGrowthAuthorityGrant, fingerprint, now, d } = fixtures;
  const { completion, receipt } = growthCompletionFixture(fixtures);

  const req = request(),
    trustedGrant = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  const done = completion(req, trustedGrant),
    exact = receipt(done);
  assert.deepEqual(validateGrowthAuthorityReceipt(exact, done, "check", fingerprint), exact);
  for (const mutate of [
    (value) => {
      value.requestDigest = d("f");
    },
    (value) => {
      value.reportDigest = d("f");
    },
    (value) => {
      value.completionDigest = d("f");
    },
    (value) => {
      value.binding.policy.scopeDigest = d("f");
    },
    (value) => {
      value.qualification = "not-qualified";
    },
  ] satisfies ((value: {
    requestDigest: `sha256:${string}`;
    reportDigest: `sha256:${string}`;
    completionDigest: `sha256:${string}`;
    binding: { policy: { scopeDigest: `sha256:${string}` } };
    qualification: "qualified" | "not-qualified";
  }) => void)[]) {
    const forged = structuredClone(exact);
    mutate(forged);
    assert.throws(() => validateGrowthAuthorityReceipt(forged, done, "check", fingerprint));
  }
}

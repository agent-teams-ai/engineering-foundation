import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { controlledNow, digest } from "./packed-sdk-growth-authority-fixture-values.ts";
import type { AuthorityApi, FixtureInput } from "./packed-sdk-growth-authority-fixture-values.ts";
import type { FixtureContext } from "./packed-sdk-growth-authority-fixture-context.ts";
import {
  assertPackedRequestCodec,
  assertPackedCompletionCodec,
  assertDistinctPromotionRequestRejected,
} from "./packed-sdk-growth-authority-fixture-codec.ts";
import type {
  SdkGrowthAuthorityTransport,
  GrowthAuthorityCompletion,
  GrowthAuthorityGrant,
  GrowthAuthorityReceipt,
  GrowthAuthorityRequest,
  GrowthDigest,
} from "../packages/engineering-foundation/dist/sdk-growth-authority.js";

type TransportState = {
  api: AuthorityApi;
  input: FixtureInput;
  fixture: FixtureContext;
  requests: Map<string, GrowthAuthorityRequest>;
  grants: Map<string, GrowthAuthorityGrant>;
  race: { mutate?: (() => Promise<void>) | undefined };
  admissionReceipt?: GrowthAuthorityReceipt;
  admissionGrant?: GrowthAuthorityGrant;
  admissionCompletion?: GrowthAuthorityCompletion;
};
function createFixtureGrant(
  state: TransportState,
  request: GrowthAuthorityRequest,
  requestDigest: GrowthDigest,
): GrowthAuthorityGrant {
  const { input } = state;
  const {
    binding,
    trustedBase,
    baseReference,
    historicalCustody,
    decisionDigest,
    archive,
    candidateArchive,
    rootEvidence,
    expectedCoverage,
  } = state.fixture;
  const now = controlledNow().getTime();
  const grant: GrowthAuthorityGrant = {
    schemaVersion: "reviewrouter:sdk-growth-authority:3",
    kind: "grant",
    grantId: `packed-${request.operation}`,
    requestDigest,
    admissionReceipt:
      request.operation === "check"
        ? { kind: "none" }
        : {
            kind: "receipt",
            receipt: {
              ...(state.admissionReceipt as GrowthAuthorityReceipt),
              provenance: {
                grant: state.admissionGrant as GrowthAuthorityGrant,
                completion: state.admissionCompletion as GrowthAuthorityCompletion,
              },
            },
          },
    binding,
    workflowRef: "packed/reviewrouter.yml@refs/heads/main",
    runRef: "packed/run/317",
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    trustedBase,
    trustedBaseReference: baseReference,
    retainedHistory: {
      targetSource: { commit: trustedBase.sourceCommit, tree: trustedBase.sourceTree },
      targetSurfaceDigest: baseReference.surfaceDigest,
      receiptDigest: digest("packed-history-receipt"),
      custodyEvidence: historicalCustody,
      custodyEvidenceDigest: digest({
        domain: "foundation:sdk-growth:custody:1",
        payload: historicalCustody,
      }),
    },
    released: [
      {
        packageName: input.packageName,
        releaseEvidence: {
          packageName: input.packageName,
          packageVersion: input.candidateVersion ?? "1.0.0",
          ...(input.positivePromotion === true ? { declaredBump: "minor" } : {}),
        },
        observation: archive.observation,
        evidence: {
          kind: "released",
          typed: input.releasedTyped,
          artifact: input.releasedArtifact,
        },
      },
    ],
    ownerEvidence: [
      {
        decisionId: input.decision.decisionId,
        ownerRef: input.decision.ownerRef,
        decisionDigest,
        authenticatedSubjectId: "packed-subject",
        authorizationEvidenceDigest: digest("packed-authorization"),
        approvalEvidenceDigest: digest("packed-approval"),
        sourceBindingDigest: requestDigest,
      },
    ],
    archives: [archive],
    candidates: [candidateArchive],
    metadataRoots: [
      {
        ...rootEvidence,
        ownerEvidence: { ...rootEvidence.ownerEvidence, sourceBindingDigest: requestDigest },
      },
    ],
    requiredCoverageDigest: digest({
      domain: "reviewrouter:sdk-growth-authority:coverage:3",
      coverage: expectedCoverage,
    }),
    requiredPhases: [
      "topology",
      "observation",
      "packed",
      "decision",
      "trusted-base",
      "released",
      "authority",
    ],
  };
  return grant;
}
function resolveFixtureGrant(state: TransportState, requestInput: unknown): string {
  const { api } = state;
  assertPackedRequestCodec(api, requestInput);
  const request = requestInput as GrowthAuthorityRequest;
  const requestDigest = digest({
    domain: "reviewrouter:sdk-growth-authority:request:3",
    request,
  });
  const grant = createFixtureGrant(state, request, requestDigest);
  const encodedGrant = api.encodeGrant(grant, { request, now: controlledNow() });
  assert.equal(
    encodedGrant.protocolDigest,
    digest({ domain: "reviewrouter:sdk-growth-authority:grant:3", grant: encodedGrant.value }),
  );
  assert.notEqual(encodedGrant.protocolDigest, encodedGrant.wireDigest);
  assert.throws(() =>
    api.encodeGrant(
      { ...grant, requestDigest: digest("wrong-request") },
      { request, now: controlledNow() },
    ),
  );
  assert.throws(() =>
    api.encodeGrant(
      { ...grant, candidates: [{ ...grant.candidates[0], packageName: "wrong-package" }] },
      { request, now: controlledNow() },
    ),
  );
  assert.throws(() =>
    api.encodeGrant(
      {
        ...grant,
        metadataRoots: [{ ...grant.metadataRoots[0], evidenceDigest: digest("wrong-root") }],
      },
      { request, now: controlledNow() },
    ),
  );
  if (request.operation === "promote-release") {
    assertDistinctPromotionRequestRejected(api, request, grant);
  }
  state.requests.set(grant.grantId, request);
  state.grants.set(grant.grantId, grant);
  if (request.operation === "check") {
    state.admissionGrant = grant;
  }
  return JSON.stringify(grant);
}
async function completeFixture(
  state: TransportState,
  completionInput: unknown,
): Promise<Uint8Array> {
  const { api, input } = state;
  const completion = completionInput as GrowthAuthorityCompletion;

  if (completion.promotion.kind === "plan") {
    await state.race.mutate?.();
  }
  const request = state.requests.get(completion.grantId),
    grant = state.grants.get(completion.grantId);
  assert.ok(request);
  assert.ok(grant);
  const finalizedReportBytes = await readFile(join(input.repositoryRoot, "reports/sdk.json"));
  assertPackedCompletionCodec(api, completion, { request, grant, finalizedReportBytes });
  const receipt: GrowthAuthorityReceipt = {
    schemaVersion: "reviewrouter:sdk-growth-authority:3",
    kind: "receipt",
    receiptId: completion.promotion.kind === "none" ? "packed-admission" : "packed-promotion",
    grantId: completion.grantId,
    grantDigest: completion.grantDigest,
    requestDigest: completion.requestDigest,
    completionDigest: digest({
      domain: "reviewrouter:sdk-growth-authority:completion:3",
      completion,
    }),
    binding: completion.binding,
    reportDigest: completion.reportDigest,
    coverageDigest: completion.coverageDigest,
    phasesDigest: completion.phasesDigest,
    verdict: completion.verdict,
    releaseEligible: completion.releaseEligible,
    qualification:
      completion.verdict === "admitted" && completion.releaseEligible
        ? "qualified"
        : "not-qualified",
    operation: completion.promotion.kind === "none" ? "check" : "promote-release",
    promotion: completion.promotion,
    custodyRef: "packed/receipts/317",
    issuedAt: controlledNow().toISOString(),
  };
  const encodedReceipt = api.encodeReceipt(receipt, {
    request,
    grant,
    completion,
    finalizedReportBytes,
  });
  assert.equal(
    encodedReceipt.wireDigest,
    `sha256:${createHash("sha256").update(encodedReceipt.wire).digest("hex")}`,
  );
  assert.equal("protocolDigest" in encodedReceipt, false);
  assert.throws(() =>
    api.encodeReceipt(
      { ...receipt, reportDigest: digest("wrong-report") },
      { request, grant, completion, finalizedReportBytes },
    ),
  );
  if (completion.promotion.kind === "none") {
    state.admissionReceipt = receipt;
    state.admissionCompletion = completion;
  }
  return new TextEncoder().encode(JSON.stringify(receipt));
}
export function createFixtureTransport(
  api: AuthorityApi,
  input: FixtureInput,
  fixture: FixtureContext,
) {
  const state: TransportState = {
    api,
    input,
    fixture,
    requests: new Map(),
    grants: new Map(),
    race: {},
  };
  const transport: SdkGrowthAuthorityTransport = {
    async resolve(request) {
      return resolveFixtureGrant(state, request);
    },
    complete(completion) {
      return completeFixture(state, completion);
    },
  };
  return { transport, race: state.race, admissionReceipt: () => state.admissionReceipt };
}

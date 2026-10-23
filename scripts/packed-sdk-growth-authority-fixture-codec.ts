import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  controlledNow,
  digest,
  errorMessage,
  errorReason,
} from "./packed-sdk-growth-authority-fixture-values.ts";
import type {
  AuthorityApi,
  CompletionContext,
} from "./packed-sdk-growth-authority-fixture-values.ts";
import type {
  GrowthAuthorityCompletion,
  GrowthAuthorityGrant,
  GrowthAuthorityRequest,
  GrowthDigest,
} from "../packages/engineering-foundation/dist/sdk-growth-authority.js";

type MutableFixtureReport = {
  authority: { receiptDigest: GrowthDigest };
  repository: string;
  candidate: { status: string; value: { sourceCommit: string; surfaceDigest: GrowthDigest } };
  transitionReceipts: { decisions: GrowthDigest[] }[];
};
export function assertDistinctPromotionRequestRejected(
  api: AuthorityApi,
  request: GrowthAuthorityRequest,
  grant: GrowthAuthorityGrant,
) {
  const differentRequest = {
    ...request,
    contextSelectors: {
      ...request.contextSelectors,
      decisionsPath: "evidence/different-decisions.json",
    },
  };
  const differentDigest = api.decodeRequest(differentRequest).protocolDigest;
  const differentGrant = {
    ...grant,
    requestDigest: differentDigest,
    ownerEvidence: grant.ownerEvidence.map((row) => ({
      ...row,
      sourceBindingDigest: differentDigest,
    })),
    metadataRoots: grant.metadataRoots.map((row) => ({
      ...row,
      ownerEvidence: { ...row.ownerEvidence, sourceBindingDigest: differentDigest },
    })),
  };
  assert.throws(
    () => api.encodeGrant(differentGrant, { request: differentRequest, now: controlledNow() }),
    (error: unknown) => errorReason(error) === "growth-authority-admission-request-mismatch",
  );
}
function assertPriorReportBindingRejected(
  api: AuthorityApi,
  completion: GrowthAuthorityCompletion,
  context: CompletionContext,
) {
  assertAlteredReportRejected(
    api,
    completion,
    context,
    (report) => {
      report.authority.receiptDigest = digest("wrong-prior-grant");
    },
    "growth-authority-completion-mismatch",
  );
}
function assertAlteredReportRejected(
  api: AuthorityApi,
  completion: GrowthAuthorityCompletion,
  context: CompletionContext,
  mutate: (report: MutableFixtureReport) => void,
  expectedReason: string,
) {
  const report = JSON.parse(context.finalizedReportBytes.toString("utf8")) as MutableFixtureReport;
  mutate(report);
  const finalizedReportBytes = Buffer.from(`${canonicalJson(report)}\n`);
  const changedCompletion = {
    ...completion,
    reportDigest: `sha256:${createHash("sha256").update(finalizedReportBytes).digest("hex")}`,
    reportByteLength: finalizedReportBytes.byteLength,
  };
  assert.throws(
    () => api.decodeCompletion(changedCompletion, { ...context, finalizedReportBytes }),
    (error: unknown) => errorReason(error) === expectedReason,
  );
}
export function assertPackedCompletionCodec(
  api: AuthorityApi,
  completion: GrowthAuthorityCompletion,
  context: CompletionContext,
) {
  const { request, grant, finalizedReportBytes } = context;
  const decodedCompletion = api.decodeCompletion(completion, {
    request,
    grant,
    finalizedReportBytes,
  });
  const overDepthReport = Buffer.from(`${"[".repeat(10000)}0${"]".repeat(10000)}`);
  assert.throws(
    () =>
      api.decodeCompletion(completion, { request, grant, finalizedReportBytes: overDepthReport }),
    (error) => error instanceof TypeError && /depth/u.test(error.message),
  );
  assertCompletionReportMutations(api, completion, context);
  assert.throws(() =>
    api.decodeCompletion(completion, {
      request,
      grant,
      finalizedReportBytes: new Proxy(finalizedReportBytes, {}),
    }),
  );
  class HostileBytes extends Uint8Array {
    override get byteLength(): number {
      throw new Error("getter executed");
    }
  }
  assert.throws(
    () =>
      api.decodeCompletion(completion, {
        request,
        grant,
        finalizedReportBytes: new HostileBytes(finalizedReportBytes),
      }),
    (error: unknown) => errorMessage(error) !== "getter executed",
  );
  assert.equal(
    decodedCompletion.protocolDigest,
    digest({
      domain: "reviewrouter:sdk-growth-authority:completion:3",
      completion: decodedCompletion.value,
    }),
  );
  assert.notEqual(decodedCompletion.protocolDigest, decodedCompletion.wireDigest);
  assert.throws(() =>
    api.decodeCompletion(
      { ...completion, grantDigest: digest("wrong-grant") },
      { request, grant, finalizedReportBytes },
    ),
  );
  assert.throws(() =>
    api.decodeCompletion(
      { ...completion, coverageDigest: digest("wrong-coverage") },
      { request, grant, finalizedReportBytes },
    ),
  );
  assert.throws(() =>
    api.decodeCompletion(
      { ...completion, phasesDigest: digest("wrong-phases") },
      { request, grant, finalizedReportBytes },
    ),
  );
  assert.throws(() =>
    api.decodeCompletion(completion, {
      request,
      grant,
      finalizedReportBytes: Buffer.concat([finalizedReportBytes, Buffer.from(" ")]),
    }),
  );
  const bomReportBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), finalizedReportBytes]);
  const bomCompletion = {
    ...completion,
    reportDigest: `sha256:${createHash("sha256").update(bomReportBytes).digest("hex")}`,
    reportByteLength: bomReportBytes.byteLength,
  };
  assert.throws(
    () =>
      api.decodeCompletion(bomCompletion, { request, grant, finalizedReportBytes: bomReportBytes }),
    (error: unknown) => errorReason(error) === "growth-authority-report-bytes-invalid",
  );
  if (completion.verdict !== "admitted") {
    assert.throws(() =>
      api.decodeCompletion(
        { ...completion, releaseEligible: true },
        { request, grant, finalizedReportBytes },
      ),
    );
  }
}

function assertCompletionReportMutations(
  api: AuthorityApi,
  completion: GrowthAuthorityCompletion,
  context: CompletionContext,
) {
  const { request, grant, finalizedReportBytes } = context;
  if (completion.promotion.kind === "plan") {
    assertPriorReportBindingRejected(api, completion, { request, grant, finalizedReportBytes });
  }
  if (completion.promotion.kind === "none" && completion.verdict === "admitted") {
    assertAlteredReportRejected(
      api,
      completion,
      { request, grant, finalizedReportBytes },
      (report) => {
        report.authority.receiptDigest = digest("wrong-current-grant");
      },
      "growth-authority-completion-report-authority-mismatch",
    );
  }
  if (completion.promotion.kind === "none") {
    assertAlteredReportRejected(
      api,
      completion,
      { request, grant, finalizedReportBytes },
      (report) => {
        report.repository = "github:999";
      },
      "growth-authority-report-source-mismatch",
    );
  }
  if (
    completion.promotion.kind === "none" &&
    (JSON.parse(finalizedReportBytes.toString("utf8")) as MutableFixtureReport).candidate.status ===
      "available"
  ) {
    assertAlteredReportRejected(
      api,
      completion,
      { request, grant, finalizedReportBytes },
      (report) => {
        report.candidate.value.sourceCommit = "9".repeat(40);
      },
      "growth-authority-report-source-mismatch",
    );
  }
  if (completion.promotion.kind === "none" && completion.verdict === "admitted") {
    assertAlteredReportRejected(
      api,
      completion,
      { request, grant, finalizedReportBytes },
      (report) => {
        report.candidate.value.surfaceDigest = digest("wrong-surface");
      },
      "growth-authority-report-source-mismatch",
    );
    assertAlteredReportRejected(
      api,
      completion,
      { request, grant, finalizedReportBytes },
      (report) => {
        report.transitionReceipts[0].decisions = [digest("wrong-owner")];
      },
      "growth-authority-report-source-mismatch",
    );
  }
}

export function assertPackedRequestCodec(api: AuthorityApi, request: unknown) {
  const decodedRequest = api.decodeRequest(request);
  assert.equal(
    decodedRequest.protocolDigest,
    digest({
      domain: "reviewrouter:sdk-growth-authority:request:3",
      request: decodedRequest.value,
    }),
  );
  assert.equal(
    decodedRequest.wireDigest,
    `sha256:${createHash("sha256").update(decodedRequest.wire).digest("hex")}`,
  );
  assert.notEqual(decodedRequest.protocolDigest, decodedRequest.wireDigest);
  assert.throws(() => api.decodeRequest('{"kind":"request","kind":"request"}'), /duplicate-key/u);
  assert.throws(() => api.decodeRequest(new Proxy(request as object, {})), /unsafe/u);
  const hostilePrototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("prototype trap executed");
      },
    },
  );
  assert.throws(
    () => api.decodeRequest(Object.create(hostilePrototype)),
    (error: unknown) => errorMessage(error) !== "prototype trap executed",
  );
  assert.throws(() => api.decodeRequest("x".repeat(32 * 1024 * 1024 + 1)));
}

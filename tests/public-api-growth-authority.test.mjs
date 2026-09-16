import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  growthAuthorityCompletionDigest,
  growthAuthorityGrantDigest,
  growthAuthorityRequestDigest,
  validateGrowthAuthorityGrant,
  validateGrowthAuthorityReceipt
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-authority.js";
import { growthObservationReference } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import { growthDimensions } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";

const fingerprint = { sha256: value => createHash("sha256").update(value).digest("hex") };
const d = character => `sha256:${character.repeat(64)}`;
const phases = ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"];
const invocation = {
  repository: "github:123", sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40),
  topologyDigest: d("1"), lockDigest: d("2"), toolchainDigest: d("3"), artifactDigests: [d("4")],
  tool: { version: "1.3.3", artifactDigest: d("5"), extractorVersion: "7.58.12" }
};
const binding = () => ({ invocation: structuredClone(invocation), target: {
  repository: { provider: "github", repositoryId: "123", owner: "agent-teams-ai", name: "engineering-foundation" },
  pullRequestNumber: 44, head: { commit: "1".repeat(40), tree: "2".repeat(40) },
  base: { commit: "3".repeat(40), tree: "4".repeat(40) }, mergeBase: { commit: "5".repeat(40), tree: "6".repeat(40) },
  evaluation: { commit: "1".repeat(40), tree: "2".repeat(40) }, evaluationKind: "head"
}, verifier: { identity: "reviewrouter/sdk-growth-authority", immutableRevision: "7".repeat(40), artifactDigest: d("6") },
tool: { packageName: "@agent-teams/engineering-foundation", version: "1.3.3", archiveDigest: d("7"),
  archiveIntegrity: `sha512-${"A".repeat(86)}==`, distributionDigest: d("5"), extractorVersion: "7.58.12" },
policy: { contractRevision: "foundation:sdk-growth:c0:5", policyVersion: "foundation:sdk-growth:policy:1",
  enrollmentRevision: "8".repeat(40), configurationDigest: d("8"), scopeDigest: d("9"), commandDigest: d("a") },
historyDigest: d("b"), evidenceManifestDigest: d("c") });

const observation = () => ({ ...structuredClone(invocation), contractRevision: "foundation:sdk-growth:c0:5",
  observationVersion: "foundation:sdk-growth:observation:1", coverage: [{ packageName: "fixture", classification: "governed",
    dimensions: growthDimensions.map(dimension => dimension === "decision"
      ? { dimension, status: "unavailable", reasons: ["s3-pending"] }
      : { dimension, status: "complete", reasons: [] }) }], entries: [] });

function request(operation = "check") {
  return { schemaVersion: "reviewrouter:sdk-growth-authority:1", kind: "request", operation,
    admissionReceiptId: operation === "check" ? null : "receipt-check", binding: binding(),
    contextSelectors: { trustedBasePath: "evidence/base.json", decisionsPath: "evidence/decisions.json", released: [] },
    decisionDigests: [], requiredPhases: phases };
}

function grant(req = request()) {
  const base = observation();
  return { schemaVersion: "reviewrouter:sdk-growth-authority:1", kind: "grant", grantId: "grant-1",
    requestDigest: growthAuthorityRequestDigest(req, fingerprint), admissionReceipt: { kind: "none" }, binding: structuredClone(req.binding),
    workflowRef: "reviewrouter/sdk-growth-authority.yml@refs/heads/main", runRef: "run/1", issuedAt: "2026-09-16T10:00:00Z",
    expiresAt: "2026-09-16T12:00:00Z", trustedBase: base, trustedBaseReference: growthObservationReference(base, fingerprint),
    retainedHistory: { targetSource: { commit: base.sourceCommit, tree: base.sourceTree },
      targetSurfaceDigest: growthObservationReference(base, fingerprint).surfaceDigest, receiptDigest: d("d"), custodyEvidenceDigest: d("f") },
    released: [], ownerEvidence: [], archives: [], requiredCoverageDigest: d("e"), requiredPhases: phases };
}

const now = new Date("2026-09-16T11:00:00Z");

test("closed trusted grant validates and its digest excludes completion and receipt", () => {
  const req = request(), value = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  const before = growthAuthorityGrantDigest(value, fingerprint);
  const copy = structuredClone(value);
  assert.equal(growthAuthorityGrantDigest(copy, fingerprint), before);
  assert.equal(value.requestDigest, growthAuthorityRequestDigest(req, fingerprint));
});

for (const [name, mutate] of [
  ["repository", value => { value.binding.target.repository.repositoryId = "124"; }],
  ["PR", value => { value.binding.target.pullRequestNumber = 45; }],
  ["head", value => { value.binding.target.head.commit = "9".repeat(40); }],
  ["base", value => { value.binding.target.base.commit = "9".repeat(40); }],
  ["merge base", value => { value.binding.target.mergeBase.commit = "9".repeat(40); }],
  ["merge result", value => { value.binding.target.evaluationKind = "merge-result"; }],
  ["verifier", value => { value.binding.verifier.immutableRevision = "9".repeat(40); }],
  ["tool archive", value => { value.binding.tool.archiveDigest = d("f"); }],
  ["distribution", value => { value.binding.tool.distributionDigest = d("f"); }],
  ["lock", value => { value.binding.invocation.lockDigest = d("f"); }],
  ["changed policy", value => { value.binding.policy.configurationDigest = d("f"); }],
  ["narrowed scope", value => { value.binding.policy.scopeDigest = d("f"); }],
  ["missing command", value => { value.binding.policy.commandDigest = d("f"); }],
  ["no-op command", value => { value.binding.policy.commandDigest = d("0"); }]
]) {
  test(`grant rejects ${name} substitution`, () => {
    const req = request(), value = grant(req); mutate(value);
    assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), /growth-authority-(?:binding|evaluation|tool-binding)-mismatch/);
  });
}

test("grant rejects unknown fields, expiration, and forged promotion prerequisites", () => {
  const req = request(), unknown = grant(req); unknown.approved = true;
  assert.throws(() => validateGrowthAuthorityGrant(unknown, req, fingerprint, now), /growth-authority-contract-invalid/);
  const expired = grant(req); expired.expiresAt = "2026-09-16T10:30:00Z";
  assert.throws(() => validateGrowthAuthorityGrant(expired, req, fingerprint, now), /growth-authority-grant-expired/);
  const promote = request("promote-release"), forged = grant(promote);
  assert.throws(() => validateGrowthAuthorityGrant(forged, promote, fingerprint, now), /growth-authority-admission-receipt-invalid/);
});

test("grant rejects unauthenticated owners, shallow history, and archive scope expansion", () => {
  const req = request();
  const owner = grant(req);
  owner.ownerEvidence = [{ decisionId: "ADR-1", ownerRef: "architecture/team", decisionDigest: d("1") }];
  assert.throws(() => validateGrowthAuthorityGrant(owner, req, fingerprint, now), /growth-authority-contract-invalid/);

  const history = grant(req);
  history.retainedHistory.targetSource.commit = "9".repeat(40);
  assert.throws(() => validateGrowthAuthorityGrant(history, req, fingerprint, now), /growth-authority-history-source-mismatch/);

  const archives = grant(req);
  archives.archives = [{ packageName: "extra", packageVersion: "1.0.0", source: structuredClone(req.binding.target.evaluation),
    archiveDigest: d("1"), archiveIntegrity: `sha512-${"A".repeat(86)}==`, custodyEvidenceDigest: d("2") }];
  assert.throws(() => validateGrowthAuthorityGrant(archives, req, fingerprint, now), /growth-authority-archive-scope-mismatch/);
});

function completion(req, trustedGrant) {
  return { schemaVersion: "reviewrouter:sdk-growth-authority:1", kind: "completion", grantId: trustedGrant.grantId,
    grantDigest: growthAuthorityGrantDigest(trustedGrant, fingerprint), requestDigest: trustedGrant.requestDigest, binding: req.binding,
    reportDigest: d("1"), reportByteLength: 100, coverageDigest: d("2"), phasesDigest: d("3"), verdict: "admitted",
    releaseEligible: true, publication: "finalized", promotion: { kind: "none" } };
}

function receipt(done) {
  return { schemaVersion: "reviewrouter:sdk-growth-authority:1", kind: "receipt", receiptId: "receipt-check", grantId: done.grantId,
    grantDigest: done.grantDigest, completionDigest: growthAuthorityCompletionDigest(done, fingerprint), binding: done.binding,
    reportDigest: done.reportDigest, coverageDigest: done.coverageDigest, phasesDigest: done.phasesDigest, verdict: done.verdict,
    releaseEligible: done.releaseEligible, qualification: "qualified", operation: "check", promotion: done.promotion,
    custodyRef: "reviewrouter/receipts/1", issuedAt: "2026-09-16T11:00:01Z" };
}

test("final receipt must bind exact finalized report and completion", () => {
  const req = request(), trustedGrant = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  const done = completion(req, trustedGrant), exact = receipt(done);
  assert.deepEqual(validateGrowthAuthorityReceipt(exact, done, "check", fingerprint), exact);
  for (const mutate of [
    value => { value.reportDigest = d("f"); }, value => { value.completionDigest = d("f"); },
    value => { value.binding.policy.scopeDigest = d("f"); }, value => { value.qualification = "not-qualified"; }
  ]) {
    const forged = structuredClone(exact); mutate(forged);
    assert.throws(() => validateGrowthAuthorityReceipt(forged, done, "check", fingerprint));
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  growthAuthorityCompletionDigest,
  growthAuthorityArtifactEvidence,
  growthAuthorityGrantDigest,
  growthAuthorityRequestDigest,
  validateGrowthAuthorityGrant,
  validateGrowthAuthorityReceipt
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-authority.js";
import { ReviewRouterGrowthAuthorityAcl } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/reviewrouter-growth-authority-acl.js";
import { VerifiedGrowthInputContext } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/verified-growth-input-context.js";
import { growthObservationReference } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import { growthDimensions } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";

const fingerprint = {
  sha256: value => createHash("sha256").update(value).digest("hex"),
  sha512Integrity: value => `sha512-${createHash("sha512").update(value).digest("base64")}`
};
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

test("grant evidence kind is bound exactly to its request selector", () => {
  const req = request();
  req.contextSelectors.released = [{ packageName: "fixture", kind: "released", observationPath: "evidence/released.json" }];
  const value = grant(req);
  value.released = [{ packageName: "fixture", releaseEvidence: { packageName: "fixture", packageVersion: "0.0.0" },
    evidence: { kind: "initial-unreleased", historyDigest: req.binding.historyDigest } }];
  value.archives = [{ packageName: "fixture", packageVersion: "0.0.0", source: structuredClone(req.binding.target.evaluation),
    archiveDigest: d("1"), archiveIntegrity: `sha512-${"A".repeat(86)}==`, custodyEvidenceDigest: d("2") }];
  assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), /growth-authority-release-selector-mismatch/);
});

test("owner evidence binds the exact request and decision proposal", () => {
  const req = request(), decisionDigest = d("1");
  req.decisionDigests = [decisionDigest];
  const value = grant(req);
  value.ownerEvidence = [{ decisionId: "ADR-1", ownerRef: "architecture/team", decisionDigest,
    authenticatedSubjectId: "subject-1", authorizationEvidenceDigest: d("2"), approvalEvidenceDigest: d("3"),
    sourceBindingDigest: growthAuthorityRequestDigest(req, fingerprint) }];
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, req, fingerprint, now));
  value.ownerEvidence[0].sourceBindingDigest = d("f");
  assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), /growth-authority-owner-source-mismatch/);
});

test("archive digest and integrity bind the supplied artifact snapshot", () => {
  const req = request();
  req.contextSelectors.released = [{ packageName: "fixture", kind: "released", observationPath: "evidence/released.json" }];
  const artifact = { schemaVersion: 1, packageName: "fixture", packageVersion: "1.0.0",
    extractorVersion: "package-artifact-inventory/1", entrypoints: [] };
  const value = grant(req), archive = growthAuthorityArtifactEvidence(artifact, fingerprint);
  value.released = [{ packageName: "fixture", releaseEvidence: { packageName: "fixture", packageVersion: "1.0.0" },
    evidence: { kind: "released", typed: { ...artifact, extractorVersion: "7.58.12" }, artifact } }];
  value.archives = [{ packageName: "fixture", packageVersion: "1.0.0", source: structuredClone(req.binding.target.evaluation),
    ...archive, custodyEvidenceDigest: d("2") }];
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, req, fingerprint, now));
  for (const field of ["archiveDigest", "archiveIntegrity"]) {
    const forged = structuredClone(value);
    forged.archives[0][field] = field === "archiveDigest" ? d("f") : `sha512-${"B".repeat(86)}==`;
    assert.throws(() => validateGrowthAuthorityGrant(forged, req, fingerprint, now), /growth-authority-archive-artifact-mismatch/);
  }
});

test("verified context rejects grant release evidence that differs from the normalized local checkout", async () => {
  const selectors = { trustedBasePath: "evidence/base.json", decisionsPath: "evidence/decisions.json",
    released: [{ packageName: "fixture", kind: "released", observationPath: "evidence/released.json" }] };
  const artifact = { schemaVersion: 1, packageName: "fixture", packageVersion: "1.0.0",
    extractorVersion: "package-artifact-inventory/1", entrypoints: [] };
  const typed = { ...artifact, extractorVersion: "7.58.12" };
  const candidate = { trustedBase: { status: "unavailable", reasons: ["candidate"] },
    trustedBaseReference: { status: "unavailable", reasons: ["candidate"] }, retainedHistory: { status: "unavailable", reasons: ["candidate"] },
    released: [{ packageName: "fixture", policy: { packageName: "fixture" },
      releaseEvidence: { status: "available", value: { packageName: "fixture", packageVersion: "1.0.1" } },
      evidence: { kind: "released", typed: { status: "available", value: typed }, artifact: { status: "available", value: artifact } } }],
    decisions: [], acceptedBreakingDecisions: { acceptedDecisionIds: [], acceptedDecisionPaths: [],
      growthDecisionAuthority: { status: "unavailable", reasons: ["candidate"] } }, authority: { status: "unverified", reasons: ["candidate"] } };
  const context = new VerifiedGrowthInputContext({ candidate: { async read() { return structuredClone(candidate); } },
    authority: { async resolve(actual) {
      const value = grant(actual), archive = growthAuthorityArtifactEvidence(artifact, fingerprint);
      value.released = [{ packageName: "fixture", releaseEvidence: { packageName: "fixture", packageVersion: "1.0.0" },
        evidence: { kind: "released", typed, artifact } }];
      value.archives = [{ packageName: "fixture", packageVersion: "1.0.0", source: structuredClone(actual.binding.target.evaluation),
        ...archive, custodyEvidenceDigest: d("2") }];
      return validateGrowthAuthorityGrant(value, actual, fingerprint, now);
    }, async complete() { throw new Error("unexpected completion"); } }, binding: binding(), operation: "check", fingerprint,
    async assertSchema() {} });
  await assert.rejects(context.read(selectors, { throwIfCancelled() {} }), /growth-authority-release-evidence-mismatch/);
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

test("authority ACL accepts only serialized JSON and preserves a valid committed receipt after late cancellation", async () => {
  const req = request(), trustedGrant = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  const done = completion(req, trustedGrant), exact = receipt(done), controller = new AbortController();
  const acl = new ReviewRouterGrowthAuthorityAcl({
    async resolve() { return new TextEncoder().encode(JSON.stringify(trustedGrant)); },
    async complete() { controller.abort(new Error("late cancellation")); return JSON.stringify(exact); }
  }, fingerprint, () => now);
  const cancellation = { signal: controller.signal, throwIfCancelled() { controller.signal.throwIfAborted(); } };
  assert.deepEqual(await acl.resolve(req, cancellation), trustedGrant);
  assert.deepEqual(await acl.complete(done, cancellation), exact);

  const trapCalls = [];
  const hostile = new Proxy({}, { get(_target, property) {
    trapCalls.push(property);
    // Promise resolution necessarily probes an object response for `then`
    // before the ACL receives it. Any other property access would be the
    // validator inspecting attacker-controlled object shape.
    if (property === "then") { return; }
    throw new Error("proxy trap executed");
  }, getPrototypeOf() { trapCalls.push("getPrototypeOf"); throw new Error("proxy trap executed"); } });
  const rejecting = new ReviewRouterGrowthAuthorityAcl({ async resolve() { return hostile; }, async complete() { return hostile; } }, fingerprint, () => now);
  await assert.rejects(rejecting.resolve(req, { throwIfCancelled() {} }), TypeError);
  assert.ok(trapCalls.length > 0);
  assert.ok(trapCalls.every(property => property === "then"));

  const duplicateKey = JSON.stringify(trustedGrant).replace('{"schemaVersion":', '{"schemaVersion":"forged","schemaVersion":');
  const duplicate = new ReviewRouterGrowthAuthorityAcl({ async resolve() { return duplicateKey; }, async complete() { return duplicateKey; } }, fingerprint, () => now);
  await assert.rejects(duplicate.resolve(req, { throwIfCancelled() {} }), /invalid strict JSON: duplicate-key/u);
});

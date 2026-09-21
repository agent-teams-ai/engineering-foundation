import { createVerifiedGrowthObservation } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/verified-growth-observation.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { types } from "node:util";

import {
  growthAuthorityCompletionDigest,
  growthAuthorityGrantDigest,
  growthAuthorityRequestDigest,
  validateGrowthAuthorityGrant as validateGrowthAuthorityGrantWithInspection,
  validateGrowthAuthorityReceipt
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-authority.js";
import { ReviewRouterGrowthAuthorityAcl } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/reviewrouter-growth-authority-acl.js";
import { VerifiedGrowthInputContext } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/verified-growth-input-context.js";
import { hashGrowthPayload } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js";
import { growthCanonicalJson, growthObservationReference, normalizeGrowthObservation } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import { admitSdkGrowth } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/admit-sdk-growth.js";

const validateGrowthAuthorityGrant = (value, authorityRequest, fingerprint, now) =>
  validateGrowthAuthorityGrantWithInspection(value, authorityRequest, fingerprint, types, now);

import { schemaVersion, fingerprint, d, invocation, binding, observation, authoritySnapshot, custody, sealEvidence, packed, request, grant, initialPackage, releasedPackage, now } from "./support/public-api-growth-authority-fixture.mjs";

test("closed v3 grant validates and binds its exact request", () => {
  const req = request(), value = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  assert.equal(value.requestDigest, growthAuthorityRequestDigest(req, fingerprint));
  assert.equal(growthAuthorityGrantDigest(structuredClone(value), fingerprint), growthAuthorityGrantDigest(value, fingerprint));
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
  ["missing command", value => { value.binding.policy.commandDigest = d("f"); }]
]) {
  test(`grant rejects ${name} substitution`, () => {
    const req = request(), value = grant(req); mutate(value);
    assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), /growth-authority-(?:binding|evaluation|tool-binding)-mismatch/);
  });
}

test("package-scope membership performs a linear number of package-name reads", () => {
  const measured = [100, 200, 400].map(size => {
    let reads = 0;
    const countPackageName = {
      get(target, property, receiver) {
        if (property === "packageName") { reads += 1; }
        return Reflect.get(target, property, receiver);
      }
    };
    const surface = observation("unused");
    surface.coverage = Array.from({ length: size }, (_, index) => {
      const packageName = `fixture-${String(index).padStart(4, "0")}`;
      return new Proxy(observation(packageName).coverage[0], countPackageName);
    });
    surface.entries = Array.from({ length: size }, (_, index) => {
      const packageName = `fixture-${String(index).padStart(4, "0")}`;
      return { coordinate: new Proxy({
        packageName, exportPath: ".", resolutionBranch: [], subject: { kind: "package" }
      }, countPackageName), value: { state: "present", digest: d("a") } };
    });
    assert.equal(normalizeGrowthObservation(surface).entries.length, size);
    return { size, reads };
  });
  assert.ok(measured.every(({ size, reads }) => reads <= size * 6), JSON.stringify(measured));
  assert.deepEqual(measured.map(({ size, reads }) => reads / size), [5, 5, 5]);
});

test("actual candidate archive bytes are distinct from an unchanged API observation", () => {
  const req = request(), value = grant(req);
  initialPackage(value, req, "fixture", "archive-one");
  sealEvidence(value, req);
  const first = validateGrowthAuthorityGrant(value, req, fingerprint, now);
  const changed = structuredClone(value);
  changed.candidates[0] = packed("fixture", "0.0.0", observation("fixture"), "archive-two");
  assert.throws(() => validateGrowthAuthorityGrant(changed, req, fingerprint, now), /evidence-manifest-mismatch/);
  const changedRequest = structuredClone(req);
  sealEvidence(changed, changedRequest);
  const second = validateGrowthAuthorityGrant(changed, changedRequest, fingerprint, now);
  assert.notEqual(first.candidates[0].archiveDigest, second.candidates[0].archiveDigest);
  assert.equal(first.candidates[0].observationDigest, second.candidates[0].observationDigest);
});

test("forged actual archive custody fails for released and initial packages", () => {
  for (const kind of ["released", "initial"]) {
    const req = request(), value = grant(req);
    if (kind === "released") { releasedPackage(value, req); }
    else { initialPackage(value, req); }
    sealEvidence(value, req);
    value.candidates[0].installedDistribution.archiveDigest = d("f");
    assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now),
      /growth-authority-installed-distribution-mismatch/);
  }
});

test("custody manifest digest rejects inventory mismatch and substitution", () => {
  const req = request(), value = grant(req);
  initialPackage(value, req, "fixture", "archive-one");
  sealEvidence(value, req);
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, req, fingerprint, now));
  const inventoryMismatch = structuredClone(value);
  inventoryMismatch.candidates[0].custodyEvidence.installedFiles[0].digest = d("f");
  assert.throws(() => validateGrowthAuthorityGrant(inventoryMismatch, req, fingerprint, now), /growth-authority-custody-manifest-mismatch/);
  const archiveSubstitution = structuredClone(value);
  archiveSubstitution.candidates[0].custodyEvidence.archiveDigest = archiveSubstitution.candidates[0].archiveDigest === d("f") ? d("e") : d("f");
  assert.throws(() => validateGrowthAuthorityGrant(archiveSubstitution, req, fingerprint, now), /growth-authority-(?:custody-inventory|archive-digest)-mismatch/);
});

test("canonical custody rejects duplicate and ambiguous inventory paths", () => {
  const req = request(), value = grant(req);
  initialPackage(value, req, "fixture", "archive-one");
  sealEvidence(value, req);
  const duplicate = structuredClone(value);
  duplicate.candidates[0].custodyEvidence.installedFiles.push({ path: "package.json", digest: d("1") });
  duplicate.candidates[0].custodyEvidence.archiveManifest.push({ path: "package.json", digest: d("1") });
  assert.throws(() => validateGrowthAuthorityGrant(duplicate, req, fingerprint, now), /custody-duplicate-path/);
  const ambiguous = structuredClone(value);
  ambiguous.candidates[0].custodyEvidence.installedFiles[0].path = "./package.json";
  assert.throws(() => validateGrowthAuthorityGrant(ambiguous, req, fingerprint, now), /path-invalid/);
});

test("canonical custody rejects valid digest substitutions even when custody is rehashed", () => {
  const req = request(), value = grant(req);
  initialPackage(value, req);
  sealEvidence(value, req);
  for (const mutate of [
    evidence => { evidence.archiveDigest = d("f"); },
    evidence => { evidence.archiveIntegrity = `sha512-${"B".repeat(86)}==`; },
    evidence => { evidence.archiveManifest[0].digest = d("f"); evidence.installedFiles[0].digest = d("f"); },
    evidence => { delete evidence.archivePayload; },
    evidence => { delete evidence.archiveManifest; },
    evidence => { const payload = JSON.parse(evidence.archivePayload); payload.files[0].contentHex = "ff";
      evidence.archivePayload = growthCanonicalJson(payload); }
  ]) {
    const forged = structuredClone(value), candidate = forged.candidates[0];
    mutate(candidate.custodyEvidence);
    candidate.archiveDigest = candidate.installedDistribution.archiveDigest = candidate.custodyEvidence.archiveDigest;
    candidate.archiveIntegrity = candidate.installedDistribution.archiveIntegrity = candidate.custodyEvidence.archiveIntegrity;
    candidate.custodyEvidenceDigest = hashGrowthPayload({ domain: "foundation:sdk-growth:custody:1", payload: candidate.custodyEvidence }, fingerprint);
    assert.throws(() => validateGrowthAuthorityGrant(forged, req, fingerprint, now), /growth-authority-/);
  }
});

test("custody paths and canonical payload encoding have one unambiguous representation", () => {
  const req = request(), value = grant(req);
  initialPackage(value, req);
  sealEvidence(value, req);
  for (const name of ["a/../b", "a//b", "a\\b", "/a", "a%2fb", "C:a", "a.", "a ", "CON", "e\u0301", "a\u0000b"]) {
    const forged = structuredClone(value), evidence = forged.candidates[0].custodyEvidence;
    const payload = JSON.parse(evidence.archivePayload); payload.files[0].path = name;
    evidence.archivePayload = JSON.stringify(payload);
    assert.throws(() => validateGrowthAuthorityGrant(forged, req, fingerprint, now), /path-invalid/, name);
  }
  for (const files of [
    [{ path: "a", contentHex: "" }, { path: "a", contentHex: "" }],
    [{ path: "A", contentHex: "" }, { path: "a", contentHex: "" }],
    [{ path: "a", contentHex: "" }, { path: "a/b", contentHex: "" }],
    [{ path: "Foo/bar", contentHex: "" }, { path: "foo", contentHex: "" }],
    [{ path: "foo", contentHex: "" }, { path: "Foo/bar", contentHex: "" }],
    [{ path: "foo/BAR/baz", contentHex: "" }, { path: "FOO/bar", contentHex: "" }],
    [{ path: "Foo\\bar", contentHex: "" }, { path: "foo", contentHex: "" }]
  ]) {
    const forged = structuredClone(value);
    forged.candidates[0].custodyEvidence.archivePayload = growthCanonicalJson({ schemaVersion: "foundation:sdk-growth:archive:1", files });
    assert.throws(() => validateGrowthAuthorityGrant(forged, req, fingerprint, now), /duplicate-path|path-invalid/);
  }
});

test("retained history requires verified custody of the exact trusted base", () => {
  const req = request(), value = grant(req);
  for (const mutate of [
    history => { history.custodyEvidenceDigest = d("f"); },
    history => { delete history.custodyEvidence; },
    history => { history.custodyEvidence = custody({ "trusted-base.json": "{}" });
      history.custodyEvidenceDigest = hashGrowthPayload({ domain: "foundation:sdk-growth:custody:1", payload: history.custodyEvidence }, fingerprint); }
  ]) {
    const forged = structuredClone(value); mutate(forged.retainedHistory);
    assert.throws(() => validateGrowthAuthorityGrant(forged, req, fingerprint, now), /growth-authority-/);
  }
});

test("released historical archive and candidate identities cannot be substituted", () => {
  const req = request(), value = grant(req); releasedPackage(value, req);
  sealEvidence(value, req);
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, req, fingerprint, now));
  const forged = structuredClone(value);
  forged.archives[0] = structuredClone(forged.candidates[0]);
  assert.throws(() => validateGrowthAuthorityGrant(forged, req, fingerprint, now),
    /growth-authority-(?:archive-version|archive-observation)-mismatch/);
});

test("all malformed authority collection rows fail with stable invariant reasons", () => {
  for (const field of ["released", "ownerEvidence", "archives", "candidates"]) {
    for (const malformed of [null, 1, "row", true]) {
      const req = request(), value = grant(req);
      value[field] = [malformed];
      assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now),
        error => error?.name === "GrowthObservationInvariantError" && typeof error.reason === "string", `${field}:${malformed}`);
    }
  }
});

const snapshotLocations = ["root", "entrypoints", "entrypoint", "items", "item"];
function snapshotAt(location, wrap) {
  const item = { canonicalReference: "A", kind: "Function", parentKind: "EntryPoint", signature: "A" };
  const entrypoint = { exportPath: ".", items: location === "item" ? [wrap(item)] : [item] };
  if (location === "items") { entrypoint.items = wrap(entrypoint.items); }
  const value = authoritySnapshot();
  value.entrypoints = location === "entrypoint" ? [wrap(entrypoint)] : [entrypoint];
  if (location === "entrypoints") { value.entrypoints = wrap(value.entrypoints); }
  return location === "root" ? wrap(value) : value;
}
function snapshotInvariant(error) {
  return error?.name === "GrowthObservationInvariantError"
    && error.reason === "growth-authority-release-snapshot-invalid";
}

test("released typed and artifact snapshots reject malformed shapes and accessors with one invariant", () => {
  let getterCalls = 0;
  const malformed = [() => null, () => 1, () => "snapshot", () => [], () => {
    const value = authoritySnapshot();
    Object.defineProperty(value, "packageVersion", {
      enumerable: true,
      get() { getterCalls += 1; throw new TypeError("snapshot getter executed"); }
    });
    return value;
  }];
  for (const branch of ["typed", "artifact"]) {
    for (const makeMalformed of malformed) {
      const req = request(), value = grant(req);
      releasedPackage(value, req);
      sealEvidence(value, req);
      value.released[0].evidence[branch] = makeMalformed();
      assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now),
        snapshotInvariant, branch);
    }
  }
  assert.equal(getterCalls, 0);
});

test("released typed and artifact snapshots reject proxies before every reflective trap", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const branch of ["typed", "artifact"]) {
    for (const location of snapshotLocations) {
      let trapCalls = 0;
      const hostile = snapshotAt(location, target => new Proxy(target, {
        get() { trapCalls += 1; throw revoked.proxy; },
        getOwnPropertyDescriptor() { trapCalls += 1; throw revoked.proxy; },
        getPrototypeOf() { trapCalls += 1; throw revoked.proxy; },
        ownKeys() { trapCalls += 1; throw revoked.proxy; }
      }));
      const req = request(), value = grant(req);
      releasedPackage(value, req);
      sealEvidence(value, req);
      value.released[0].evidence[branch] = hostile;
      assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), snapshotInvariant, `${branch}:${location}`);
      assert.equal(trapCalls, 0, `${branch}:${location}`);
    }
  }
});

test("released typed and artifact snapshots reject revoked proxies with the stable invariant", () => {
  for (const branch of ["typed", "artifact"]) {
    for (const location of snapshotLocations) {
      const hostile = snapshotAt(location, target => {
        const revocable = Proxy.revocable(target, {});
        revocable.revoke();
        return revocable.proxy;
      });
      const req = request(), value = grant(req);
      releasedPackage(value, req);
      sealEvidence(value, req);
      value.released[0].evidence[branch] = hostile;
      assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), snapshotInvariant, `${branch}:${location}`);
    }
  }
});

test("released typed and artifact signatures match the schema boundaries exactly", () => {
  for (const branch of ["typed", "artifact"]) {
    for (const length of [0, 4096, 4097, 10_000, 10_001]) {
      const req = request(), value = grant(req);
      releasedPackage(value, req);
      sealEvidence(value, req);
      value.released[0].evidence[branch] = snapshotAt("item", item => ({ ...item, signature: "x".repeat(length) }));
      if (length <= 10_000) {
        assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), `${branch}:${length}`);
      } else {
        assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), snapshotInvariant, `${branch}:${length}`);
      }
    }
  }
});

test("duplicate packed snapshots fail closed and large matching collections remain valid", () => {
  const duplicateRequest = request(), duplicate = grant(duplicateRequest);
  initialPackage(duplicate, duplicateRequest);
  duplicate.candidates.push(structuredClone(duplicate.candidates[0]));
  duplicate.requestDigest = growthAuthorityRequestDigest(duplicateRequest, fingerprint);
  assert.throws(() => validateGrowthAuthorityGrant(duplicate, duplicateRequest, fingerprint, now),
    /growth-authority-candidate-duplicate/);

  const req = request(), value = grant(req);
  for (let index = 0; index < 1_000; index += 1) { initialPackage(value, req, `fixture-${index}`); }
  req.contextSelectors.released = req.contextSelectors.released.toSorted((a, b) => a.packageName.localeCompare(b.packageName));
  value.released = value.released.toSorted((a, b) => a.packageName.localeCompare(b.packageName));
  value.candidates = value.candidates.toSorted((a, b) => a.packageName.localeCompare(b.packageName));
  sealEvidence(value, req);
  assert.equal(validateGrowthAuthorityGrant(value, req, fingerprint, now).candidates.length, 1_000);
});

function completion(req, trustedGrant) {
  return { schemaVersion, kind: "completion", grantId: trustedGrant.grantId,
    grantDigest: growthAuthorityGrantDigest(trustedGrant, fingerprint), requestDigest: trustedGrant.requestDigest, binding: req.binding,
    reportDigest: d("1"), reportByteLength: 100, coverageDigest: trustedGrant.requiredCoverageDigest, phasesDigest: d("3"), verdict: "admitted",
    releaseEligible: true, publication: "finalized", promotion: { kind: "none" } };
}
function receipt(done, grantEvidence) {
  return { schemaVersion, kind: "receipt", receiptId: "receipt-check", grantId: done.grantId,
    grantDigest: done.grantDigest, requestDigest: done.requestDigest,
    completionDigest: growthAuthorityCompletionDigest(done, fingerprint), binding: done.binding,
    reportDigest: done.reportDigest, coverageDigest: done.coverageDigest, phasesDigest: done.phasesDigest, verdict: done.verdict,
    releaseEligible: done.releaseEligible, qualification: "qualified", operation: "check", promotion: done.promotion,
    custodyRef: "reviewrouter/receipts/1", issuedAt: "2026-09-16T11:00:00Z",
    ...(grantEvidence === undefined ? {} : { provenance: { grant: grantEvidence, completion: done } }) };
}

test("promotion validates a nested positive check receipt and rejects request, binding and digest mutations", () => {
  const checkRequest = request(), checkGrant = validateGrowthAuthorityGrant(grant(checkRequest), checkRequest, fingerprint, now);
  const checkCompletion = completion(checkRequest, checkGrant), accepted = receipt(checkCompletion, checkGrant);
  const promote = request("promote-release"), value = grant(promote);
  value.admissionReceipt = { kind: "receipt", receipt: accepted };
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, promote, fingerprint, now));
  for (const mutate of [
    nested => { nested.requestDigest = d("f"); },
    nested => { nested.binding.policy.scopeDigest = d("f"); },
    nested => { nested.grantDigest = "invalid"; },
    nested => { nested.grantDigest = d("f"); },
    nested => { nested.grantId = "different-valid-id"; },
    nested => { nested.completionDigest = d("f"); }
  ]) {
    const forged = structuredClone(value); mutate(forged.admissionReceipt.receipt);
    assert.throws(() => validateGrowthAuthorityGrant(forged, promote, fingerprint, now));
  }
  for (const mutate of [
    req => { req.contextSelectors.decisionsPath = "evidence/other.json"; },
    req => { req.decisionDigests = [d("f")]; },
    req => { req.binding.policy.configurationDigest = d("f"); }
  ]) {
    const changed = structuredClone(promote); mutate(changed);
    const forged = grant(changed); forged.admissionReceipt = { kind: "receipt", receipt: accepted };
    assert.throws(() => validateGrowthAuthorityGrant(forged, changed, fingerprint, now),
      /growth-authority-admission-(?:request|binding)-mismatch/);
  }
});

test("promotion verifies prior completion fields and requires full prior evidence", () => {
  const checkRequest = request(), checkGrant = validateGrowthAuthorityGrant(grant(checkRequest), checkRequest, fingerprint, now);
  const done = completion(checkRequest, checkGrant), accepted = receipt(done, checkGrant);
  const promote = request("promote-release"), value = grant(promote);
  value.admissionReceipt = { kind: "receipt", receipt: accepted };
  for (const mutate of [
    nested => { delete nested.provenance; },
    nested => { nested.provenance.grant.grantId = "another-grant"; },
    nested => { nested.provenance.completion.grantId = "another-grant"; },
    nested => { nested.provenance.completion.requestDigest = d("f"); },
    nested => { nested.provenance.completion.reportDigest = d("f"); },
    nested => { nested.provenance.completion.coverageDigest = d("f"); },
    nested => { nested.provenance.completion.phasesDigest = d("f"); },
    nested => { nested.provenance.completion.binding.policy.scopeDigest = d("f"); },
    nested => { nested.provenance.completion.publication = "pending"; },
    nested => { nested.provenance.completion.reportByteLength = 0; },
    nested => { nested.provenance.completion.promotion = { kind: "plan", planDigest: d("f") }; }
  ]) {
    const forged = structuredClone(value), nested = forged.admissionReceipt.receipt;
    mutate(nested);
    if (nested.provenance) { nested.completionDigest = growthAuthorityCompletionDigest(nested.provenance.completion, fingerprint); }
    assert.throws(() => validateGrowthAuthorityGrant(forged, promote, fingerprint, now), /growth-authority-/);
  }
  const later = new Date("2026-09-16T11:30:00Z");
  const prior = structuredClone(checkGrant); prior.expiresAt = "2026-09-16T11:10:00Z";
  value.admissionReceipt.receipt = receipt(completion(checkRequest, prior), prior);
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, promote, fingerprint, later));
});

function promotionGrantWithCandidate() {
  const checkRequest = request(), checkWire = grant(checkRequest);
  initialPackage(checkWire, checkRequest);
  sealEvidence(checkWire, checkRequest);
  const checkGrant = validateGrowthAuthorityGrant(checkWire, checkRequest, fingerprint, now);
  const checkCompletion = completion(checkRequest, checkGrant), accepted = receipt(checkCompletion, checkGrant);
  const promote = { ...structuredClone(checkRequest), operation: "promote-release", admissionReceiptId: accepted.receiptId };
  const value = grant(promote);
  value.released = structuredClone(checkGrant.released);
  value.candidates = structuredClone(checkGrant.candidates);
  value.requestDigest = growthAuthorityRequestDigest(promote, fingerprint);
  value.admissionReceipt = { kind: "receipt", receipt: accepted };
  return { promote, value };
}

function synchronizePackedObservation(candidate) {
  candidate.source = { commit: candidate.observation.sourceCommit, tree: candidate.observation.sourceTree };
  candidate.installedDistribution.source = structuredClone(candidate.source);
  candidate.observationDigest = growthObservationReference(candidate.observation, fingerprint).surfaceDigest;
  candidate.installedDistribution.observationDigest = candidate.observationDigest;
}

test("promotion rejects every candidate invocation identity mutation", () => {
  const exact = promotionGrantWithCandidate();
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(exact.value, exact.promote, fingerprint, now));
  for (const [dimension, mutate, expected] of [
    ["repository", candidate => { candidate.observation.repository = "github:999"; }, /growth-authority-packed-repository-mismatch/u],
    ["source commit", candidate => { candidate.observation.sourceCommit = "9".repeat(40); }, /growth-authority-candidate-invocation-mismatch/u],
    ["source tree", candidate => { candidate.observation.sourceTree = "9".repeat(40); }, /growth-authority-candidate-invocation-mismatch/u],
    ["topology digest", candidate => { candidate.observation.topologyDigest = d("f"); }, /growth-authority-candidate-invocation-mismatch/u],
    ["lock digest", candidate => { candidate.observation.lockDigest = d("f"); }, /growth-authority-candidate-invocation-mismatch/u],
    ["toolchain digest", candidate => { candidate.observation.toolchainDigest = d("f"); }, /growth-authority-candidate-invocation-mismatch/u],
    ["artifact digests", candidate => { candidate.observation.artifactDigests = [d("f")]; }, /growth-authority-candidate-invocation-mismatch/u],
    ["tool version", candidate => { candidate.observation.tool.version = "1.3.4"; }, /growth-authority-candidate-invocation-mismatch/u],
    ["tool distribution artifact", candidate => { candidate.observation.tool.artifactDigest = d("f"); }, /growth-authority-candidate-invocation-mismatch/u],
    ["tool extractor", candidate => { candidate.observation.tool.extractorVersion = "7.58.13"; }, /growth-authority-candidate-invocation-mismatch/u]
  ]) {
    const { promote, value } = promotionGrantWithCandidate();
    mutate(value.candidates[0]);
    synchronizePackedObservation(value.candidates[0]);
    assert.throws(() => validateGrowthAuthorityGrant(value, promote, fingerprint, now), expected, dimension);
  }
});

test("final receipt binds exact request, report and completion", () => {
  const req = request(), trustedGrant = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  const done = completion(req, trustedGrant), exact = receipt(done);
  assert.deepEqual(validateGrowthAuthorityReceipt(exact, done, "check", fingerprint), exact);
  for (const mutate of [
    value => { value.requestDigest = d("f"); }, value => { value.reportDigest = d("f"); },
    value => { value.completionDigest = d("f"); }, value => { value.binding.policy.scopeDigest = d("f"); },
    value => { value.qualification = "not-qualified"; }
  ]) {
    const forged = structuredClone(exact); mutate(forged);
    assert.throws(() => validateGrowthAuthorityReceipt(forged, done, "check", fingerprint));
  }
});

function emptyCandidate(decisions = []) {
  return { trustedBase: { status: "unavailable", reasons: ["candidate"] },
    trustedBaseReference: { status: "unavailable", reasons: ["candidate"] }, retainedHistory: { status: "unavailable", reasons: ["candidate"] },
    released: [], decisions, acceptedBreakingDecisions: { acceptedDecisionIds: [], acceptedDecisionPaths: [],
      growthDecisionAuthority: { status: "unavailable", reasons: ["candidate"] } }, authority: { status: "unverified", reasons: ["candidate"] } };
}

test("verified context lifecycle rejects concurrent and reused reads deterministically", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const context = new VerifiedGrowthInputContext({ candidate: { async read() { await waiting; return emptyCandidate(); } },
    authority: { async resolve(actual) { return validateGrowthAuthorityGrant(grant(actual), actual, fingerprint, now); },
      async complete() { throw new Error("unexpected"); } }, binding: binding(), operation: "check", fingerprint, async assertSchema() {} });
  const selectors = { trustedBasePath: "base.json", decisionsPath: "decisions.json", released: [] };
  const first = context.read(selectors, { throwIfCancelled() {} });
  await assert.rejects(context.read(selectors, { throwIfCancelled() {} }), /growth-authority-read-in-progress/);
  release();
  await first;
  await assert.rejects(context.read(selectors, { throwIfCancelled() {} }), /growth-authority-reused/);
});

test("verified context requests authority only for valid uniquely identified decisions", async () => {
  const valid = { contractRevision: "foundation:sdk-growth:c0:5", decisionId: "ADR-1", ownerRef: "owner/team",
    stability: "supported", transitions: [d("1")], coordinates: [{ packageName: "fixture", exportPath: ".", resolutionBranch: [], subject: { kind: "package" } }],
    changeFingerprint: d("2"), consumerEvidenceRefs: [{ useCase: "test", repository: "repo",
      source: { tree: "1".repeat(40), contentDigest: d("3"), commit: null }, artifactDigest: null }],
    exposureRationale: "exposed", compatibilityRationale: "compatible", lifecycle: { kind: "ordinary" } };
  const overlapA = { ...structuredClone(valid), decisionId: "ADR-2", transitions: [d("4")], changeFingerprint: d("5") };
  const overlapB = { ...structuredClone(valid), decisionId: "ADR-3", transitions: [d("4")], changeFingerprint: d("6") };
  let observed;
  const context = new VerifiedGrowthInputContext({ candidate: { async read() {
    return emptyCandidate([valid, structuredClone(valid), overlapA, overlapB, null]);
  } },
    authority: { async resolve(actual) { observed = actual; return validateGrowthAuthorityGrant(grant(actual), actual, fingerprint, now); },
      async complete() { throw new Error("unexpected"); } }, binding: binding(), operation: "check", fingerprint, async assertSchema() {} });
  await context.read({ trustedBasePath: "base.json", decisionsPath: "decisions.json", released: [] }, { throwIfCancelled() {} });
  assert.deepEqual(observed.decisionDigests, []);
});

test("verified context semantically rejects duplicate items and wrong package or extractor after schema parsing", async () => {
  const selectors = { trustedBasePath: "base.json", decisionsPath: "decisions.json",
    released: [{ packageName: "fixture", kind: "released", observationPath: "released.json" }] };
  const makeLocal = () => ({ ...emptyCandidate(), released: [{ packageName: "fixture",
    policy: { packageName: "fixture" }, releaseEvidence: { status: "available", value: { packageName: "fixture", packageVersion: "1.0.0", declaredBump: "minor" } },
    evidence: { kind: "released", typed: { status: "unavailable", reasons: ["candidate"] }, artifact: { status: "unavailable", reasons: ["candidate"] } } }] });
  for (const mutate of [
    row => { row.evidence.typed.packageName = "other"; },
    row => { row.evidence.typed.extractorVersion = "wrong"; },
    row => { row.evidence.typed.entrypoints = [{ exportPath: ".", items: [
      { canonicalReference: "A", kind: "Function", parentKind: "EntryPoint", signature: "A" },
      { canonicalReference: "A", kind: "Function", parentKind: "EntryPoint", signature: "A" }
    ] }]; }
  ]) {
    const context = new VerifiedGrowthInputContext({ candidate: { async read() { return makeLocal(); } },
      authority: { async resolve(actual) {
        const value = grant(actual); releasedPackage(value, { ...actual, contextSelectors: { ...actual.contextSelectors, released: [] } });
        sealEvidence(value, actual);
        mutate(value.released[0]);
        return validateGrowthAuthorityGrant(value, actual, fingerprint, now);
      }, async complete() { throw new Error("unexpected"); } }, binding: binding(), operation: "check", fingerprint, async assertSchema() {} });
    await assert.rejects(context.read(selectors, { throwIfCancelled() {} }),
      error => error?.problem?.code === "PUBLIC_API_BASELINE_INVALID");
  }
});

test("authority ACL accepts strict JSON and preserves a committed receipt after late cancellation", async () => {
  const req = request(), trustedGrant = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  const done = completion(req, trustedGrant), exact = receipt(done), controller = new AbortController();
  const acl = new ReviewRouterGrowthAuthorityAcl({
    async resolve() { return new TextEncoder().encode(JSON.stringify(trustedGrant)); },
    async complete() { controller.abort(new Error("late cancellation")); return JSON.stringify(exact); }
  }, fingerprint, () => now);
  const cancellation = { signal: controller.signal, throwIfCancelled() { controller.signal.throwIfAborted(); } };
  assert.deepEqual(await acl.resolve(req, cancellation), trustedGrant);
  assert.deepEqual(await acl.complete(done, cancellation), exact);
});

async function runTrustedObservationBoundary(status) {
    const local = observation("fixture");
    const packedDimension = local.coverage[0].dimensions.find(entry => entry.dimension === "packed");
    packedDimension.status = "unavailable"; packedDimension.reasons = ["local-packed-unavailable"];
    const trusted = observation("fixture", status);
    const base = observation("fixture");
    const reference = growthObservationReference(base, fingerprint);
    const authorityDigest = d("f");
    const artifact = { schemaVersion: 1, packageName: "fixture", packageVersion: "0.0.0",
      extractorVersion: "package-artifact-inventory/1", entrypoints: [] };
    const typed = { ...artifact, extractorVersion: "7.58.12" };
    const context = { trustedBase: { status: "available", value: base },
      trustedBaseReference: { status: "available", value: reference },
      retainedHistory: { status: "available", value: { targetSurfaceDigest: reference.surfaceDigest, receiptDigest: d("d") } },
      released: [{ packageName: "fixture", policy: { packageName: "fixture", approvedBreakingChanges: [] },
        releaseEvidence: { status: "available", value: { packageName: "fixture", packageVersion: "0.0.0", declaredBump: "minor" } },
        qualification: { receiptDigest: authorityDigest },
        evidence: { kind: "initial-unreleased", history: { status: "available", value: d("b") } } }],
      packedCandidates: [packed("fixture", "0.0.0", trusted)],
      decisions: [], acceptedBreakingDecisions: { acceptedDecisionIds: [], acceptedDecisionPaths: [],
        growthDecisionAuthority: { status: "available", value: [] } },
      authority: { status: "verified", receiptDigest: authorityDigest, workflowRef: "workflow", runRef: "run" } };
    const execution = { identity: structuredClone(invocation), surface: { status: "available", value: local },
      compatibilitySnapshots: [{ packageName: "fixture",
        typed: { kind: "typed", snapshot: { status: "available", value: typed } },
        artifact: { kind: "artifact", snapshot: { status: "available", value: artifact } } }] };
    return admitSdkGrowth({ invocation, context: { trustedBasePath: "base.json", decisionsPath: "decisions.json",
      released: [{ packageName: "fixture", kind: "initial-unreleased", trustedHistoryPath: "history.json" }] },
      cancellation: { throwIfCancelled() {} } }, {
      observation: createVerifiedGrowthObservation({ async observe() { return execution; } }, { packedCandidates: () => context.packedCandidates, resolution: () => ({ grant: { metadataRoots: [] } }) }),
      context: { async read() { return context; } }, fingerprint
    });
}

test("trusted observation boundary preserves the selected S1 payload without context rewriting", async () => {
  const complete = await runTrustedObservationBoundary("complete");
  assert.equal(complete.admission.status, "admitted");
  assert.equal(complete.observation.surface.value.coverage[0].dimensions.find(entry => entry.dimension === "packed").status, "complete");
  const incomplete = await runTrustedObservationBoundary("limited");
  assert.equal(incomplete.comparison.status, "incomplete");
  assert.equal(incomplete.observation.surface.value.coverage[0].dimensions.find(entry => entry.dimension === "typed").status, "limited");
});

test("complete packed absence rejects a workspace-only retained base coordinate", async () => {
  const coordinate = { packageName: "fixture", exportPath: ".", resolutionBranch: [], subject: { kind: "package" } };
  const entry = { coordinate, value: { state: "present", digest: d("a") } };
  const base = observation("fixture");
  base.entries = [structuredClone(entry)];
  const local = observation("fixture");
  local.entries = [structuredClone(entry)];
  const localPacked = local.coverage[0].dimensions.find(dimension => dimension.dimension === "packed");
  localPacked.status = "unavailable";
  localPacked.reasons = ["workspace-does-not-prove-packed-presence"];
  const packedObservation = observation("fixture");
  packedObservation.entries = [];
  const reference = growthObservationReference(base, fingerprint);
  const authorityDigest = d("f");
  const artifact = { schemaVersion: 1, packageName: "fixture", packageVersion: "0.0.0",
    extractorVersion: "package-artifact-inventory/1", entrypoints: [] };
  const typed = { ...artifact, extractorVersion: "7.58.12" };
  const context = {
    trustedBase: { status: "available", value: base },
    trustedBaseReference: { status: "available", value: reference },
    retainedHistory: { status: "available", value: { targetSurfaceDigest: reference.surfaceDigest, receiptDigest: d("d") } },
    released: [{ packageName: "fixture", policy: { packageName: "fixture", approvedBreakingChanges: [] },
      releaseEvidence: { status: "available", value: { packageName: "fixture", packageVersion: "0.0.0", declaredBump: "minor" } },
      qualification: { receiptDigest: authorityDigest },
      evidence: { kind: "initial-unreleased", history: { status: "available", value: d("b") } } }],
    packedCandidates: [packed("fixture", "0.0.0", packedObservation)],
    decisions: [],
    acceptedBreakingDecisions: { acceptedDecisionIds: [], acceptedDecisionPaths: [],
      growthDecisionAuthority: { status: "available", value: [] } },
    authority: { status: "verified", receiptDigest: authorityDigest, workflowRef: "workflow", runRef: "run" }
  };
  const execution = { identity: structuredClone(invocation), surface: { status: "available", value: local },
    compatibilitySnapshots: [{ packageName: "fixture",
      typed: { kind: "typed", snapshot: { status: "available", value: typed } },
      artifact: { kind: "artifact", snapshot: { status: "available", value: artifact } } }] };
  await assert.rejects(admitSdkGrowth({
    invocation,
    context: { trustedBasePath: "base.json", decisionsPath: "decisions.json",
      released: [{ packageName: "fixture", kind: "initial-unreleased", trustedHistoryPath: "history.json" }] },
    cancellation: { throwIfCancelled() {} }
  }, {
    observation: createVerifiedGrowthObservation({ async observe() { return execution; } }, { packedCandidates: () => context.packedCandidates, resolution: () => ({ grant: { metadataRoots: [] } }) }),
    context: { async read() { return context; } },
    fingerprint
  }), /growth-authority-packed-absence-mismatch/u);
});

test("archive package identity survives fully recomputed producer custody claims", () => {
  for (const contents of [
    {}, { "unrelated.txt": "unrelated" }, { "PACKAGE.JSON": '{"name":"fixture","version":"0.0.0"}' },
    { "package.json": "null" }, { "package.json": "{" }, { "package.json": Buffer.from([255]) },
    { "package.json": JSON.stringify({ name: "unrelated", version: "0.0.0" }) },
    { "package.json": JSON.stringify({ name: "fixture", version: "9.9.9" }) }
  ]) {
    for (const kind of ["candidate", "archive"]) {
      const req = request(), value = grant(req);
      if (kind === "archive") { releasedPackage(value, req); } else { initialPackage(value, req); }
      const candidate = kind === "archive" ? value.archives[0] : value.candidates[0];
      candidate.custodyEvidence = custody(contents);
      candidate.archiveDigest = candidate.installedDistribution.archiveDigest = candidate.custodyEvidence.archiveDigest;
      candidate.archiveIntegrity = candidate.installedDistribution.archiveIntegrity = candidate.custodyEvidence.archiveIntegrity;
      candidate.custodyEvidenceDigest = hashGrowthPayload({ domain: "foundation:sdk-growth:custody:1", payload: candidate.custodyEvidence }, fingerprint);
      sealEvidence(value, req);
      assert.throws(() => validateGrowthAuthorityGrant(value, req, fingerprint, now), /growth-authority-archive-package-/);
    }
  }
});

test("ACL requires an independent installed inventory and rejects self-consistent producer substitutions", async t => {
  const req = request(), value = grant(req);
  initialPackage(value, req);
  sealEvidence(value, req);
  // Independently observed installation; never read from a returned grant.
  const installed = [
    { path: "package.json", bytes: Buffer.from('{"name":"fixture","version":"0.0.0"}') },
    { path: "content.txt", bytes: Buffer.from("candidate:fixture:0.0.0") }
  ];
  const installedRoot = await mkdtemp(join(tmpdir(), "growth-independent-inventory-"));
  t.after(() => rm(installedRoot, { recursive: true, force: true }));
  for (const file of installed) { await writeFile(join(installedRoot, file.path), file.bytes); }
  const transport = { async resolve() { return JSON.stringify(value); }, async complete() { throw new Error("unexpected"); } };
  const cancellation = { throwIfCancelled() {} };
  const reader = { async read(identity) {
    assert.deepEqual(Object.keys(identity).toSorted(), ["archiveDigest", "archiveIntegrity", "packageName", "packageVersion", "source"]);
    return Promise.all((await readdir(installedRoot)).map(async path => ({ path, bytes: await readFile(join(installedRoot, path)) })));
  } };
  await assert.rejects(new ReviewRouterGrowthAuthorityAcl(transport, fingerprint, () => now).resolve(req, cancellation), /installed-inventory-unavailable/);
  const acl = new ReviewRouterGrowthAuthorityAcl(transport, fingerprint, () => now, reader);
  await acl.resolve(req, cancellation);
  for (const observed of [[], installed.slice(1), [...installed, { path: "extra", bytes: Buffer.from("") }],
    installed.map(file => ({ ...file, bytes: Buffer.from("tampered") }))]) {
    await assert.rejects(new ReviewRouterGrowthAuthorityAcl(transport, fingerprint, () => now,
      { async read() { return observed; } }).resolve(req, cancellation), /installed-inventory-mismatch/);
  }
  await writeFile(join(installedRoot, "content.txt"), "installed-drift");
  await assert.rejects(acl.resolve(req, cancellation), /installed-inventory-mismatch/);
  await writeFile(join(installedRoot, "content.txt"), "candidate:fixture:0.0.0");
  value.candidates[0] = packed("fixture", "0.0.0", observation("fixture"), "forged-payload");
  sealEvidence(value, req);
  await assert.rejects(acl.resolve(req, cancellation), /installed-inventory-mismatch/);
});


test("ACL independently observes both released and candidate installations", async () => {
  const req = request(), value = grant(req);
  releasedPackage(value, req);
  sealEvidence(value, req);
  const observed = new Map([
    ["0.9.0", [{ path: "package.json", bytes: Buffer.from('{"name":"fixture","version":"0.9.0"}') },
      { path: "content.txt", bytes: Buffer.from("historic:fixture") }]],
    ["1.0.0", [{ path: "package.json", bytes: Buffer.from('{"name":"fixture","version":"1.0.0"}') },
      { path: "content.txt", bytes: Buffer.from("candidate:fixture") }]]
  ]);
  const calls = [];
  const acl = new ReviewRouterGrowthAuthorityAcl({ async resolve() { return JSON.stringify(value); },
    async complete() { throw new Error("unexpected"); } }, fingerprint, () => now, { async read(identity) {
    calls.push(identity.packageVersion);
    return observed.get(identity.packageVersion);
  } });
  const cancellation = { throwIfCancelled() {} };
  await acl.resolve(req, cancellation);
  assert.deepEqual(calls, ["0.9.0", "1.0.0"]);
  observed.get("0.9.0")[1].bytes = Buffer.from("changed historical installation");
  await assert.rejects(acl.resolve(req, cancellation), /installed-inventory-mismatch/);
});


test("curated SDK authority entrypoint has no forgotten public type exports", async () => {
  const packageRoot = resolvePath("packages/engineering-foundation");
  const { preparePublicApiExtractor, invokePublicApiExtractor } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/prepare-public-api-extractor.js");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sdk-authority-public-api-"));
  try {
    const config = preparePublicApiExtractor({ packageRoot,
      entryPointPath: join(packageRoot, "dist/sdk-growth-authority.d.ts"),
      tsconfigPath: join(packageRoot, "tsconfig.json"), manifestPath: join(packageRoot, "package.json"),
      apiJsonPath: join(temporaryRoot, "authority.api.json"), includeForgottenExports: false });
    const errors = [];
    const result = invokePublicApiExtractor(config, undefined, message => {
      if (message.logLevel === "error") { errors.push({ id: message.messageId, text: message.text }); }
      message.handled = true;
    });
    assert.deepEqual(errors, []);
    assert.equal(result.succeeded, true);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

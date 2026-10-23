import {
  makeLocal,
  emptyCandidate,
  validGrowthDecision,
  invalidCustodyPaths,
  ambiguousArchiveFiles,
  invalidArchiveManifests,
} from "./support/growth-authority-wire-vectors.ts";
import {
  growthCompletionFixture,
  assertFinalAuthorityReceipt,
} from "./support/growth-completion-fixture.ts";
import { registerReleasedSnapshotCases } from "./public-api-growth-snapshot-cases.ts";
import { grantBindingMutations } from "./support/growth-authority-binding-mutations.ts";
import {
  promotionCandidateMutations,
  synchronizePackedObservation,
} from "./support/growth-authority-candidate-mutations.ts";
import {
  assertMalformedAuthorityCollections,
  assertClosedGrantRequest,
  assertLinearPackageMembership,
  assertDistinctArchiveIdentity,
  assertForgedArchiveCustody,
  assertCustodyManifestBinding,
  assertCanonicalCustodyPaths,
  assertReleasedArchiveIdentity,
  assertPackedCollectionUniqueness,
} from "./support/growth-authority-custody-assertions.ts";
import {
  assertIndependentInstalledInventory,
  assertReleasedAndCandidateInventory,
} from "./support/growth-authority-inventory-assertions.ts";
import { createVerifiedGrowthObservation } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/verified-growth-observation.js";
import assert from "node:assert/strict";

import test from "node:test";
import { types } from "node:util";

import {
  growthAuthorityCompletionDigest,
  growthAuthorityRequestDigest,
  validateGrowthAuthorityGrant as validateGrowthAuthorityGrantWithInspection,
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-authority.js";
import { ReviewRouterGrowthAuthorityAcl } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/reviewrouter-growth-authority-acl.js";
import { VerifiedGrowthInputContext } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/verified-growth-input-context.js";
import { hashGrowthPayload } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js";
import {
  growthCanonicalJson,
  growthObservationReference,
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import { admitSdkGrowth } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/admit-sdk-growth.js";

const validateGrowthAuthorityGrant = (value, authorityRequest, fingerprint, now) =>
  validateGrowthAuthorityGrantWithInspection(value, authorityRequest, fingerprint, types, now);

import {
  fingerprint,
  d,
  invocation,
  binding,
  observation,
  authoritySnapshot,
  custody,
  sealEvidence,
  packed,
  request,
  grant,
  initialPackage,
  releasedPackage,
  now,
} from "./support/public-api-growth-authority-fixture.mjs";

const growthFixturePorts = {
  request,
  grant,
  validateGrowthAuthorityGrant,
  fingerprint,
  now,
  d,
  observation,
  packed,
  initialPackage,
  releasedPackage,
  sealEvidence,
};

test("closed v3 grant validates and binds its exact request", () =>
  assertClosedGrantRequest(growthFixturePorts));

for (const [name, mutate] of grantBindingMutations()) {
  test(`grant rejects ${name} substitution`, () => {
    const req = request(),
      value = grant(req);
    mutate(value);
    assert.throws(
      () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
      /growth-authority-(?:binding|evaluation|tool-binding)-mismatch/,
    );
  });
}

test("package-scope membership performs a linear number of package-name reads", () =>
  assertLinearPackageMembership(growthFixturePorts));

test("actual candidate archive bytes are distinct from an unchanged API observation", () =>
  assertDistinctArchiveIdentity(growthFixturePorts));

test("forged actual archive custody fails for released and initial packages", () =>
  assertForgedArchiveCustody(growthFixturePorts));

test("custody manifest digest rejects inventory mismatch and substitution", () =>
  assertCustodyManifestBinding(growthFixturePorts));

test("canonical custody rejects duplicate and ambiguous inventory paths", () =>
  assertCanonicalCustodyPaths(growthFixturePorts));

test("canonical custody rejects valid digest substitutions even when custody is rehashed", () => {
  const req = request(),
    value = grant(req);
  initialPackage(value, req);
  sealEvidence(value, req);
  for (const mutate of [
    (evidence) => {
      evidence.archiveDigest = d("f");
    },
    (evidence) => {
      evidence.archiveIntegrity = `sha512-${"B".repeat(86)}==`;
    },
    (evidence) => {
      evidence.archiveManifest[0].digest = d("f");
      evidence.installedFiles[0].digest = d("f");
    },
    (evidence) => {
      delete evidence.archivePayload;
    },
    (evidence) => {
      delete evidence.archiveManifest;
    },
    (evidence) => {
      const payload = JSON.parse(evidence.archivePayload);
      payload.files[0].contentHex = "ff";
      evidence.archivePayload = growthCanonicalJson(payload);
    },
  ]) {
    const forged = structuredClone(value),
      candidate = forged.candidates[0];
    mutate(candidate.custodyEvidence);
    candidate.archiveDigest = candidate.installedDistribution.archiveDigest =
      candidate.custodyEvidence.archiveDigest;
    candidate.archiveIntegrity = candidate.installedDistribution.archiveIntegrity =
      candidate.custodyEvidence.archiveIntegrity;
    candidate.custodyEvidenceDigest = hashGrowthPayload(
      { domain: "foundation:sdk-growth:custody:1", payload: candidate.custodyEvidence },
      fingerprint,
    );
    assert.throws(
      () => validateGrowthAuthorityGrant(forged, req, fingerprint, now),
      /growth-authority-/,
    );
  }
});

test("custody paths and canonical payload encoding have one unambiguous representation", () => {
  const req = request(),
    value = grant(req);
  initialPackage(value, req);
  sealEvidence(value, req);
  for (const name of invalidCustodyPaths()) {
    const forged = structuredClone(value),
      evidence = forged.candidates[0].custodyEvidence;
    const payload = JSON.parse(evidence.archivePayload);
    payload.files[0].path = name;
    evidence.archivePayload = JSON.stringify(payload);
    assert.throws(
      () => validateGrowthAuthorityGrant(forged, req, fingerprint, now),
      /path-invalid/,
      name,
    );
  }
  for (const files of ambiguousArchiveFiles()) {
    const forged = structuredClone(value);
    forged.candidates[0].custodyEvidence.archivePayload = growthCanonicalJson({
      schemaVersion: "foundation:sdk-growth:archive:1",
      files,
    });
    assert.throws(
      () => validateGrowthAuthorityGrant(forged, req, fingerprint, now),
      /duplicate-path|path-invalid/,
    );
  }
});

test("retained history requires verified custody of the exact trusted base", () => {
  const req = request(),
    value = grant(req);
  for (const mutate of [
    (history) => {
      history.custodyEvidenceDigest = d("f");
    },
    (history) => {
      delete history.custodyEvidence;
    },
    (history) => {
      history.custodyEvidence = custody({ "trusted-base.json": "{}" });
      history.custodyEvidenceDigest = hashGrowthPayload(
        { domain: "foundation:sdk-growth:custody:1", payload: history.custodyEvidence },
        fingerprint,
      );
    },
  ]) {
    const forged = structuredClone(value);
    mutate(forged.retainedHistory);
    assert.throws(
      () => validateGrowthAuthorityGrant(forged, req, fingerprint, now),
      /growth-authority-/,
    );
  }
});

test("released historical archive and candidate identities cannot be substituted", () =>
  assertReleasedArchiveIdentity(growthFixturePorts));

test("all malformed authority collection rows fail with stable invariant reasons", () =>
  assertMalformedAuthorityCollections(growthFixturePorts));

registerReleasedSnapshotCases({ ...growthFixturePorts, authoritySnapshot });

test("duplicate packed snapshots fail closed and large matching collections remain valid", () =>
  assertPackedCollectionUniqueness(growthFixturePorts));

const { completion, receipt } = growthCompletionFixture(growthFixturePorts);

test("promotion validates a nested positive check receipt and rejects request, binding and digest mutations", () => {
  const checkRequest = request(),
    checkGrant = validateGrowthAuthorityGrant(grant(checkRequest), checkRequest, fingerprint, now);
  const checkCompletion = completion(checkRequest, checkGrant),
    accepted = receipt(checkCompletion, checkGrant);
  const promote = request("promote-release"),
    value = grant(promote);
  value.admissionReceipt = { kind: "receipt", receipt: accepted };
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, promote, fingerprint, now));
  for (const mutate of [
    (nested) => {
      nested.requestDigest = d("f");
    },
    (nested) => {
      nested.binding.policy.scopeDigest = d("f");
    },
    (nested) => {
      nested.grantDigest = "invalid";
    },
    (nested) => {
      nested.grantDigest = d("f");
    },
    (nested) => {
      nested.grantId = "different-valid-id";
    },
    (nested) => {
      nested.completionDigest = d("f");
    },
  ]) {
    const forged = structuredClone(value);
    mutate(forged.admissionReceipt.receipt);
    assert.throws(() => validateGrowthAuthorityGrant(forged, promote, fingerprint, now));
  }
  for (const mutate of [
    (req) => {
      req.contextSelectors.decisionsPath = "evidence/other.json";
    },
    (req) => {
      req.decisionDigests = [d("f")];
    },
    (req) => {
      req.binding.policy.configurationDigest = d("f");
    },
  ]) {
    const changed = structuredClone(promote);
    mutate(changed);
    const forged = grant(changed);
    forged.admissionReceipt = { kind: "receipt", receipt: accepted };
    assert.throws(
      () => validateGrowthAuthorityGrant(forged, changed, fingerprint, now),
      /growth-authority-admission-(?:request|binding)-mismatch/,
    );
  }
});

test("promotion verifies prior completion fields and requires full prior evidence", () => {
  const checkRequest = request(),
    checkGrant = validateGrowthAuthorityGrant(grant(checkRequest), checkRequest, fingerprint, now);
  const done = completion(checkRequest, checkGrant),
    accepted = receipt(done, checkGrant);
  const promote = request("promote-release"),
    value = grant(promote);
  value.admissionReceipt = { kind: "receipt", receipt: accepted };
  for (const mutate of [
    (nested) => {
      delete nested.provenance;
    },
    (nested) => {
      nested.provenance.grant.grantId = "another-grant";
    },
    (nested) => {
      nested.provenance.completion.grantId = "another-grant";
    },
    (nested) => {
      nested.provenance.completion.requestDigest = d("f");
    },
    (nested) => {
      nested.provenance.completion.reportDigest = d("f");
    },
    (nested) => {
      nested.provenance.completion.coverageDigest = d("f");
    },
    (nested) => {
      nested.provenance.completion.phasesDigest = d("f");
    },
    (nested) => {
      nested.provenance.completion.binding.policy.scopeDigest = d("f");
    },
    (nested) => {
      nested.provenance.completion.publication = "pending";
    },
    (nested) => {
      nested.provenance.completion.reportByteLength = 0;
    },
    (nested) => {
      nested.provenance.completion.promotion = { kind: "plan", planDigest: d("f") };
    },
  ]) {
    const forged = structuredClone(value),
      nested = forged.admissionReceipt.receipt;
    mutate(nested);
    if (nested.provenance) {
      nested.completionDigest = growthAuthorityCompletionDigest(
        nested.provenance.completion,
        fingerprint,
      );
    }
    assert.throws(
      () => validateGrowthAuthorityGrant(forged, promote, fingerprint, now),
      /growth-authority-/,
    );
  }
  const later = new Date("2026-09-16T11:30:00Z");
  const prior = structuredClone(checkGrant);
  prior.expiresAt = "2026-09-16T11:10:00Z";
  value.admissionReceipt.receipt = receipt(completion(checkRequest, prior), prior);
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, promote, fingerprint, later));
});

function promotionGrantWithCandidate() {
  const checkRequest = request(),
    checkWire = grant(checkRequest);
  initialPackage(checkWire, checkRequest);
  sealEvidence(checkWire, checkRequest);
  const checkGrant = validateGrowthAuthorityGrant(checkWire, checkRequest, fingerprint, now);
  const checkCompletion = completion(checkRequest, checkGrant),
    accepted = receipt(checkCompletion, checkGrant);
  const promote = {
    ...structuredClone(checkRequest),
    operation: "promote-release",
    admissionReceiptId: accepted.receiptId,
  };
  const value = grant(promote);
  value.released = structuredClone(checkGrant.released);
  value.candidates = structuredClone(checkGrant.candidates);
  value.requestDigest = growthAuthorityRequestDigest(promote, fingerprint);
  value.admissionReceipt = { kind: "receipt", receipt: accepted };
  return { promote, value };
}

test("promotion rejects every candidate invocation identity mutation", () => {
  const exact = promotionGrantWithCandidate();
  assert.doesNotThrow(() =>
    validateGrowthAuthorityGrant(exact.value, exact.promote, fingerprint, now),
  );
  for (const [dimension, mutate, expected] of promotionCandidateMutations()) {
    const { promote, value } = promotionGrantWithCandidate();
    mutate(value.candidates[0]);
    synchronizePackedObservation(value.candidates[0], fingerprint);
    assert.throws(
      () => validateGrowthAuthorityGrant(value, promote, fingerprint, now),
      expected,
      dimension,
    );
  }
});

test("final receipt binds exact request, report and completion", () =>
  assertFinalAuthorityReceipt(growthFixturePorts));

test("verified context lifecycle rejects concurrent and reused reads deterministically", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const context = new VerifiedGrowthInputContext({
    candidate: {
      async read() {
        await waiting;
        return emptyCandidate();
      },
    },
    authority: {
      async resolve(actual) {
        return validateGrowthAuthorityGrant(grant(actual), actual, fingerprint, now);
      },
      async complete() {
        throw new Error("unexpected");
      },
    },
    binding: binding(),
    operation: "check",
    fingerprint,
    async assertSchema() {},
  });
  const selectors = { trustedBasePath: "base.json", decisionsPath: "decisions.json", released: [] };
  const first = context.read(selectors, { throwIfCancelled() {} });
  await assert.rejects(
    context.read(selectors, { throwIfCancelled() {} }),
    /growth-authority-read-in-progress/,
  );
  release();
  await first;
  await assert.rejects(
    context.read(selectors, { throwIfCancelled() {} }),
    /growth-authority-reused/,
  );
});

test("verified context requests authority only for valid uniquely identified decisions", async () => {
  const valid = validGrowthDecision();
  const overlapA = {
    ...structuredClone(valid),
    decisionId: "ADR-2",
    transitions: [d("4")],
    changeFingerprint: d("5"),
  };
  const overlapB = {
    ...structuredClone(valid),
    decisionId: "ADR-3",
    transitions: [d("4")],
    changeFingerprint: d("6"),
  };
  let observed;
  const context = new VerifiedGrowthInputContext({
    candidate: {
      async read() {
        return emptyCandidate([valid, structuredClone(valid), overlapA, overlapB, null]);
      },
    },
    authority: {
      async resolve(actual) {
        observed = actual;
        return validateGrowthAuthorityGrant(grant(actual), actual, fingerprint, now);
      },
      async complete() {
        throw new Error("unexpected");
      },
    },
    binding: binding(),
    operation: "check",
    fingerprint,
    async assertSchema() {},
  });
  await context.read(
    { trustedBasePath: "base.json", decisionsPath: "decisions.json", released: [] },
    { throwIfCancelled() {} },
  );
  assert.deepEqual(observed.decisionDigests, []);
});

test("verified context semantically rejects duplicate items and wrong package or extractor after schema parsing", async () => {
  const selectors = {
    trustedBasePath: "base.json",
    decisionsPath: "decisions.json",
    released: [{ packageName: "fixture", kind: "released", observationPath: "released.json" }],
  };
  for (const mutate of [
    (row) => {
      row.evidence.typed.packageName = "other";
    },
    (row) => {
      row.evidence.typed.extractorVersion = "wrong";
    },
    (row) => {
      row.evidence.typed.entrypoints = [
        {
          exportPath: ".",
          items: [
            { canonicalReference: "A", kind: "Function", parentKind: "EntryPoint", signature: "A" },
            { canonicalReference: "A", kind: "Function", parentKind: "EntryPoint", signature: "A" },
          ],
        },
      ];
    },
  ]) {
    const context = new VerifiedGrowthInputContext({
      candidate: {
        async read() {
          return makeLocal();
        },
      },
      authority: {
        async resolve(actual) {
          const value = grant(actual);
          releasedPackage(value, {
            ...actual,
            contextSelectors: { ...actual.contextSelectors, released: [] },
          });
          sealEvidence(value, actual);
          mutate(value.released[0]);
          return validateGrowthAuthorityGrant(value, actual, fingerprint, now);
        },
        async complete() {
          throw new Error("unexpected");
        },
      },
      binding: binding(),
      operation: "check",
      fingerprint,
      async assertSchema() {},
    });
    await assert.rejects(
      context.read(selectors, { throwIfCancelled() {} }),
      (error) => error?.problem?.code === "PUBLIC_API_BASELINE_INVALID",
    );
  }
});

test("authority ACL accepts strict JSON and preserves a committed receipt after late cancellation", async () => {
  const req = request(),
    trustedGrant = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  const done = completion(req, trustedGrant),
    exact = receipt(done),
    controller = new AbortController();
  const acl = new ReviewRouterGrowthAuthorityAcl(
    {
      async resolve() {
        return new TextEncoder().encode(JSON.stringify(trustedGrant));
      },
      async complete() {
        controller.abort(new Error("late cancellation"));
        return JSON.stringify(exact);
      },
    },
    fingerprint,
    () => now,
  );
  const cancellation = {
    signal: controller.signal,
    throwIfCancelled() {
      controller.signal.throwIfAborted();
    },
  };
  assert.deepEqual(await acl.resolve(req, cancellation), trustedGrant);
  assert.deepEqual(await acl.complete(done, cancellation), exact);
});

async function runTrustedObservationBoundary(status) {
  const local = observation("fixture");
  const packedDimension = local.coverage[0].dimensions.find(
    (entry) => entry.dimension === "packed",
  );
  packedDimension.status = "unavailable";
  packedDimension.reasons = ["local-packed-unavailable"];
  const trusted = observation("fixture", status);
  const base = observation("fixture");
  const reference = growthObservationReference(base, fingerprint);
  const authorityDigest = d("f");
  const artifact = {
    schemaVersion: 1,
    packageName: "fixture",
    packageVersion: "0.0.0",
    extractorVersion: "package-artifact-inventory/1",
    entrypoints: [],
  };
  const typed = { ...artifact, extractorVersion: "7.58.12" };
  const context = {
    trustedBase: { status: "available", value: base },
    trustedBaseReference: { status: "available", value: reference },
    retainedHistory: {
      status: "available",
      value: { targetSurfaceDigest: reference.surfaceDigest, receiptDigest: d("d") },
    },
    released: [
      {
        packageName: "fixture",
        policy: { packageName: "fixture", approvedBreakingChanges: [] },
        releaseEvidence: {
          status: "available",
          value: { packageName: "fixture", packageVersion: "0.0.0", declaredBump: "minor" },
        },
        qualification: { receiptDigest: authorityDigest },
        evidence: { kind: "initial-unreleased", history: { status: "available", value: d("b") } },
      },
    ],
    packedCandidates: [packed("fixture", "0.0.0", trusted)],
    decisions: [],
    acceptedBreakingDecisions: {
      acceptedDecisionIds: [],
      acceptedDecisionPaths: [],
      growthDecisionAuthority: { status: "available", value: [] },
    },
    authority: {
      status: "verified",
      receiptDigest: authorityDigest,
      workflowRef: "workflow",
      runRef: "run",
    },
  };
  const execution = {
    identity: structuredClone(invocation),
    surface: { status: "available", value: local },
    compatibilitySnapshots: [
      {
        packageName: "fixture",
        typed: { kind: "typed", snapshot: { status: "available", value: typed } },
        artifact: { kind: "artifact", snapshot: { status: "available", value: artifact } },
      },
    ],
  };
  return admitSdkGrowth(
    {
      invocation,
      context: {
        trustedBasePath: "base.json",
        decisionsPath: "decisions.json",
        released: [
          {
            packageName: "fixture",
            kind: "initial-unreleased",
            trustedHistoryPath: "history.json",
          },
        ],
      },
      cancellation: { throwIfCancelled() {} },
    },
    {
      observation: createVerifiedGrowthObservation(
        {
          async observe() {
            return execution;
          },
        },
        {
          packedCandidates: () => context.packedCandidates,
          resolution: () => ({ grant: { metadataRoots: [] } }),
        },
      ),
      context: {
        async read() {
          return context;
        },
      },
      fingerprint,
    },
  );
}

test("trusted observation boundary preserves the selected S1 payload without context rewriting", async () => {
  const complete = await runTrustedObservationBoundary("complete");
  assert.equal(complete.admission.status, "admitted");
  assert.equal(
    complete.observation.surface.value.coverage[0].dimensions.find(
      (entry) => entry.dimension === "packed",
    ).status,
    "complete",
  );
  const incomplete = await runTrustedObservationBoundary("limited");
  assert.equal(incomplete.comparison.status, "incomplete");
  assert.equal(
    incomplete.observation.surface.value.coverage[0].dimensions.find(
      (entry) => entry.dimension === "typed",
    ).status,
    "limited",
  );
});

test("complete packed absence rejects a workspace-only retained base coordinate", async () => {
  const coordinate = {
    packageName: "fixture",
    exportPath: ".",
    resolutionBranch: [],
    subject: { kind: "package" },
  };
  const entry = { coordinate, value: { state: "present", digest: d("a") } };
  const base = observation("fixture");
  base.entries = [structuredClone(entry)];
  const local = observation("fixture");
  local.entries = [structuredClone(entry)];
  const localPacked = local.coverage[0].dimensions.find(
    (dimension) => dimension.dimension === "packed",
  );
  localPacked.status = "unavailable";
  localPacked.reasons = ["workspace-does-not-prove-packed-presence"];
  const packedObservation = observation("fixture");
  packedObservation.entries = [];
  const reference = growthObservationReference(base, fingerprint);
  const authorityDigest = d("f");
  const artifact = {
    schemaVersion: 1,
    packageName: "fixture",
    packageVersion: "0.0.0",
    extractorVersion: "package-artifact-inventory/1",
    entrypoints: [],
  };
  const typed = { ...artifact, extractorVersion: "7.58.12" };
  const context = {
    trustedBase: { status: "available", value: base },
    trustedBaseReference: { status: "available", value: reference },
    retainedHistory: {
      status: "available",
      value: { targetSurfaceDigest: reference.surfaceDigest, receiptDigest: d("d") },
    },
    released: [
      {
        packageName: "fixture",
        policy: { packageName: "fixture", approvedBreakingChanges: [] },
        releaseEvidence: {
          status: "available",
          value: { packageName: "fixture", packageVersion: "0.0.0", declaredBump: "minor" },
        },
        qualification: { receiptDigest: authorityDigest },
        evidence: { kind: "initial-unreleased", history: { status: "available", value: d("b") } },
      },
    ],
    packedCandidates: [packed("fixture", "0.0.0", packedObservation)],
    decisions: [],
    acceptedBreakingDecisions: {
      acceptedDecisionIds: [],
      acceptedDecisionPaths: [],
      growthDecisionAuthority: { status: "available", value: [] },
    },
    authority: {
      status: "verified",
      receiptDigest: authorityDigest,
      workflowRef: "workflow",
      runRef: "run",
    },
  };
  const execution = {
    identity: structuredClone(invocation),
    surface: { status: "available", value: local },
    compatibilitySnapshots: [
      {
        packageName: "fixture",
        typed: { kind: "typed", snapshot: { status: "available", value: typed } },
        artifact: { kind: "artifact", snapshot: { status: "available", value: artifact } },
      },
    ],
  };
  await assert.rejects(
    admitSdkGrowth(
      {
        invocation,
        context: {
          trustedBasePath: "base.json",
          decisionsPath: "decisions.json",
          released: [
            {
              packageName: "fixture",
              kind: "initial-unreleased",
              trustedHistoryPath: "history.json",
            },
          ],
        },
        cancellation: { throwIfCancelled() {} },
      },
      {
        observation: createVerifiedGrowthObservation(
          {
            async observe() {
              return execution;
            },
          },
          {
            packedCandidates: () => context.packedCandidates,
            resolution: () => ({ grant: { metadataRoots: [] } }),
          },
        ),
        context: {
          async read() {
            return context;
          },
        },
        fingerprint,
      },
    ),
    /growth-authority-packed-absence-mismatch/u,
  );
});

test("archive package identity survives fully recomputed producer custody claims", () => {
  for (const contents of invalidArchiveManifests()) {
    for (const kind of ["candidate", "archive"]) {
      const req = request(),
        value = grant(req);
      if (kind === "archive") {
        releasedPackage(value, req);
      } else {
        initialPackage(value, req);
      }
      const candidate = kind === "archive" ? value.archives[0] : value.candidates[0];
      candidate.custodyEvidence = custody(contents);
      candidate.archiveDigest = candidate.installedDistribution.archiveDigest =
        candidate.custodyEvidence.archiveDigest;
      candidate.archiveIntegrity = candidate.installedDistribution.archiveIntegrity =
        candidate.custodyEvidence.archiveIntegrity;
      candidate.custodyEvidenceDigest = hashGrowthPayload(
        { domain: "foundation:sdk-growth:custody:1", payload: candidate.custodyEvidence },
        fingerprint,
      );
      sealEvidence(value, req);
      assert.throws(
        () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
        /growth-authority-archive-package-/,
      );
    }
  }
});

test("ACL requires an independent installed inventory and rejects self-consistent producer substitutions", async (t) =>
  assertIndependentInstalledInventory(t, growthFixturePorts));

test("ACL independently observes both released and candidate installations", async () =>
  assertReleasedAndCandidateInventory(growthFixturePorts));

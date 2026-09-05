import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertDocumentReceiptDigest,
  documentReceiptDigest,
} from "../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function clone(value) {
  return structuredClone(value);
}

function withReceiptDigest(receipt) {
  receipt.receiptDigest = documentReceiptDigest(receipt);
  return receipt;
}

test("binds every Receipt outcome to its exact commit observation", () => {
  const appliedNotPublished = clone(fixture.receipt);
  appliedNotPublished.commit = {
    state: "not-published",
    publication: "none",
    atomicity: "not-applicable",
    recoverability: "not-required",
  };
  assert.throws(
    () =>
      assertDocumentReceiptDigest(
        withReceiptDigest(appliedNotPublished),
        fixture.plan,
      ),
    /outcome and commit/u,
  );

  const alreadyAppliedPublished = clone(fixture.receipt);
  alreadyAppliedPublished.outcome = "already-applied";
  alreadyAppliedPublished.commit.publication = "published";
  assert.throws(() =>
    assertDocumentReceiptDigest(withReceiptDigest(alreadyAppliedPublished)),
  );

  const notPublishedOutcome = clone(fixture.receipt);
  notPublishedOutcome.outcome = "rejected";
  delete notPublishedOutcome.resultDigest;
  notPublishedOutcome.commit = {
    state: "committed",
    publication: "published",
    atomicity: "single-file-atomic-create",
    recoverability: "not-required",
  };
  assert.throws(() =>
    assertDocumentReceiptDigest(withReceiptDigest(notPublishedOutcome)),
  );
});

test("does not permit cross-outcome or incoherent recovery observations", () => {
  const recoveryWithoutPreservation = clone(fixture.receipt);
  recoveryWithoutPreservation.outcome = "recovery-required";
  delete recoveryWithoutPreservation.resultDigest;
  recoveryWithoutPreservation.commit = {
    state: "recovery-required",
    publication: "unknown",
    atomicity: "single-file-atomic-create",
    recoverability: "not-required",
  };
  assert.throws(() =>
    assertDocumentReceiptDigest(withReceiptDigest(recoveryWithoutPreservation)),
  );

  const crossOutcomeRecovery = clone(recoveryWithoutPreservation);
  crossOutcomeRecovery.commit = {
    state: "manual-recovery-required",
    publication: "unknown",
    atomicity: "not-applicable",
    recoverability: "preserved-for-recovery",
  };
  assert.throws(() =>
    assertDocumentReceiptDigest(withReceiptDigest(crossOutcomeRecovery)),
  );

  const publishedWithoutAtomicCreate = clone(recoveryWithoutPreservation);
  publishedWithoutAtomicCreate.commit = {
    state: "recovery-required",
    publication: "published",
    atomicity: "not-applicable",
    recoverability: "preserved-for-recovery",
  };
  assert.throws(() =>
    assertDocumentReceiptDigest(withReceiptDigest(publishedWithoutAtomicCreate)),
  );
});

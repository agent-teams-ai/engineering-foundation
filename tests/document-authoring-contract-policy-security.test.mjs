import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson } from "../packages/engineering-foundation/dist/canonical-json.js";
import {
  documentReceiptDigest,
} from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-contract-digests.js";
import {
  assertDocumentReceipt,
  createDocumentReceipt,
} from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-receipt-policy.js";
import {
  assertDocumentTransactionEnvelope,
  createDocumentTransactionEnvelope,
} from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-transaction-envelope-policy.js";
import {
  documentTransactionEnvelopeDigest,
  documentTransactionPayloadDigest,
} from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-transaction-digests.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const identity = {
  adapter: "node-filesystem",
  version: 1,
  dev: "1",
  ino: "2",
  birthtimeNs: "3",
};

function body(state, journal) {
  return {
    schemaVersion: 3,
    operationKind: "document-authoring",
    recoveryHandler: {
      id: "foundation.document-authoring",
      contractVersion: 2,
    },
    foundation: {
      version: fixture.plan.compiler.version,
      buildIdentity: fixture.plan.compiler.buildIdentity,
    },
    adapterContractVersion: 1,
    payloadKind: "document-authoring-journal/v2",
    journal: {
      schemaVersion: 2,
      plan: fixture.plan,
      ...journal,
    },
    state,
  };
}

test("enforces the closed v3 lifecycle matrix and physical publication identity", async () => {
  const prepared = await createDocumentTransactionEnvelope(body("PREPARED", {
    destination: { path: fixture.plan.destination, state: "pending" },
  }));
  assert.equal(prepared.schemaVersion, 3);
  assert.equal(Object.isFrozen(prepared.journal.plan), true);

  const published = await createDocumentTransactionEnvelope(body("PUBLISHED", {
    destination: { path: fixture.plan.destination, state: "published" },
    publicationIdentity: identity,
  }));
  assert.equal(published.journal.publicationIdentity.ino, "2");

  await assert.rejects(createDocumentTransactionEnvelope(body("PREPARED", {
    destination: { path: fixture.plan.destination, state: "pending" },
    publicationIdentity: identity,
  })), /closed v3 schema/u);
  await assert.rejects(createDocumentTransactionEnvelope(body("PUBLISHED", {
    destination: { path: fixture.plan.destination, state: "published" },
    publicationIdentity: { ...identity, ino: "0" },
  })), /closed v3 schema/u);
  await assert.rejects(createDocumentTransactionEnvelope(body("PUBLISHING", {
    destination: { path: fixture.plan.destination, state: "publishing" },
    ownedTemporary: {
      path: `docs/decisions/.foundation-document-${fixture.plan.planDigest.slice(7)}.tmp`,
      digest: fixture.plan.output.digest,
      identity: { ...identity, ino: "0" },
    },
  })), /zero/u);

  const persisted = await createDocumentTransactionEnvelope(body("PUBLISHING", {
    destination: { path: fixture.plan.destination, state: "publishing" },
    ownedTemporary: {
      path: `docs/decisions/.foundation-document-${fixture.plan.planDigest.slice(7)}.tmp`,
      digest: fixture.plan.output.digest,
      identity,
    },
  }));
  const zeroPersisted = structuredClone(persisted);
  zeroPersisted.journal.ownedTemporary.identity.ino = "0";
  zeroPersisted.payloadDigest = documentTransactionPayloadDigest(
    zeroPersisted.journal,
  );
  zeroPersisted.envelopeDigest = documentTransactionEnvelopeDigest(
    zeroPersisted,
  );
  await assert.rejects(
    assertDocumentTransactionEnvelope(zeroPersisted),
    /zero/u,
  );
});

test("strict receipt policy rejects extras, unsafe paths, excessive diagnostics, and missing Plan", async () => {
  const receipt = structuredClone(fixture.receipt);
  receipt.extra = true;
  receipt.receiptDigest = documentReceiptDigest(receipt);
  await assert.rejects(assertDocumentReceipt(receipt, fixture.plan));

  const unsafe = structuredClone(fixture.receipt);
  unsafe.destination = "../../escape";
  unsafe.receiptDigest = documentReceiptDigest(unsafe);
  await assert.rejects(assertDocumentReceipt(unsafe, fixture.plan));

  const excessive = structuredClone(fixture.receipt);
  excessive.diagnostics = Array.from({ length: 257 }, () => ({
    ruleId: "docs.receipt",
    severity: "error",
    phase: "apply",
    subject: "document",
    message: "invalid",
  }));
  excessive.receiptDigest = documentReceiptDigest(excessive);
  await assert.rejects(assertDocumentReceipt(excessive, fixture.plan));

  const mismatchedRecovery = structuredClone(fixture.receipt);
  mismatchedRecovery.outcome = "recovery-required";
  delete mismatchedRecovery.resultDigest;
  mismatchedRecovery.commit = {
    state: "manual-recovery-required",
    publication: "unknown",
    atomicity: "not-applicable",
    recoverability: "preserved-for-recovery",
  };
  mismatchedRecovery.receiptDigest = documentReceiptDigest(mismatchedRecovery);
  await assert.rejects(
    assertDocumentReceipt(mismatchedRecovery, fixture.plan),
    /outcome and commit/u,
  );

  const { receiptDigest: _digest, ...receiptBody } = fixture.receipt;
  await assert.rejects(
    createDocumentReceipt(receiptBody),
    /undefined|object|Plan/u,
  );
});

test("receipt assertion snapshots and deep-freezes accepted evidence", async () => {
  const validated = await assertDocumentReceipt(
    JSON.parse(canonicalJson(fixture.receipt)),
    fixture.plan,
  );
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.commit), true);
  assert.equal(Object.isFrozen(validated.diagnostics), true);
});

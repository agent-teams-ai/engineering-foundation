import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createDocumentReceipt,
} from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-receipt-policy.js";
import {
  assertDocumentTransactionEnvelope,
  createDocumentTransactionEnvelope,
} from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-transaction-envelope-policy.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function preparedBody() {
  return {
    schemaVersion: 2,
    operationKind: "document-authoring",
    recoveryHandler: {
      id: "foundation.document-authoring",
      contractVersion: 1,
    },
    foundation: {
      version: fixture.plan.compiler.version,
      buildIdentity: fixture.plan.compiler.buildIdentity,
    },
    adapterContractVersion: 1,
    payloadKind: "document-authoring-journal/v1",
    journal: {
      schemaVersion: 1,
      plan: fixture.plan,
      destination: {
        path: fixture.plan.destination,
        state: "pending",
      },
    },
    state: "PREPARED",
  };
}

test("creates a Receipt that is bound to the exact Plan", () => {
  const { receiptDigest: _ignored, ...body } = fixture.receipt;
  const receipt = createDocumentReceipt(body, fixture.plan);
  assert.match(receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/u);

  assert.throws(
    () => createDocumentReceipt({ ...body, destination: "docs/other.md" }, fixture.plan),
    /does not bind|result evidence/u,
  );
});

test("creates and validates the closed PREPARED envelope", () => {
  const envelope = createDocumentTransactionEnvelope(preparedBody());
  assert.equal(envelope.state, "PREPARED");
  assert.match(envelope.payloadDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotThrow(() => assertDocumentTransactionEnvelope(envelope));
});

test("rejects envelope tampering and cross-state lifecycle aliases", () => {
  const envelope = createDocumentTransactionEnvelope(preparedBody());
  assert.throws(
    () => assertDocumentTransactionEnvelope({ ...envelope, payloadDigest: "sha256:" + "0".repeat(64) }),
    /digest/u,
  );
  assert.throws(
    () =>
      createDocumentTransactionEnvelope({
        ...preparedBody(),
        state: "PUBLISHING",
      }),
    /lifecycle|temporary/u,
  );
});

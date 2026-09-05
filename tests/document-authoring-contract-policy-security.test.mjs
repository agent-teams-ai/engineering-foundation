import { envelopeBodyV4 } from "../packages/document-authoring/dist/document-authoring/application/policies/document-transaction-envelope-body.js";
import { documentTemporaryPath } from "../packages/document-authoring/dist/document-authoring/application/policies/document-temporary-path.js";
import { currentDocumentContractFixture, fixtureKernelArtifact } from "./support/current-document-contract-fixture.mjs";
import { assertSchema } from "../packages/document-authoring/dist/document-authoring/adapters/node/schema-catalog.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson } from "../packages/engineering-foundation/dist/canonical-json.js";
import {
  documentPlanDigest,
  documentReceiptDigest,
} from "../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";
import {
  assertDocumentReceipt as assertDocumentReceiptWithSchema,
  createDocumentReceipt as createDocumentReceiptWithSchema,
} from "../packages/document-authoring/dist/document-authoring/application/policies/document-receipt-policy.js";
import {
  assertDocumentTransactionEnvelope as assertDocumentTransactionEnvelopeWithSchema,
  createDocumentTransactionEnvelope as createDocumentTransactionEnvelopeWithSchema,
} from "../packages/document-authoring/dist/document-authoring/application/policies/document-transaction-envelope-policy.js";
import {
  documentTransactionEnvelopeDigest,
  documentTransactionPayloadDigest,
} from "../packages/document-authoring/dist/document-authoring/application/policies/document-transaction-digests.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const historicalFixture = JSON.parse(await readFile(fixturePath, "utf8"));
const fixture = currentDocumentContractFixture(historicalFixture);

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
      id: "document-authoring",
      contractVersion: 2,
    },
    foundation: {
      version: fixture.plan.compiler.version,
      buildIdentity: fixture.plan.compiler.buildIdentity,
    },
    kernelArtifact: fixtureKernelArtifact,
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
  })), /closed versioned schema/u);
  await assert.rejects(createDocumentTransactionEnvelope(body("PUBLISHED", {
    destination: { path: fixture.plan.destination, state: "published" },
    publicationIdentity: { ...identity, ino: "0" },
  })), /closed versioned schema/u);
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

function createDocumentReceipt(...args) { return createDocumentReceiptWithSchema({ assertSchema }, ...args); }

function assertDocumentReceipt(...args) { return assertDocumentReceiptWithSchema({ assertSchema }, ...args); }

function createDocumentTransactionEnvelope(...args) { return createDocumentTransactionEnvelopeWithSchema({ assertSchema }, ...args); }

function assertDocumentTransactionEnvelope(...args) { return assertDocumentTransactionEnvelopeWithSchema({ assertSchema }, ...args); }

const nativeFixtureRoot = new URL("../packages/document-authoring/tests/fixtures/schema-recovery/", import.meta.url);

async function candidateEnvelope(generation) {
  const value = JSON.parse(await readFile(new URL(`current-document-envelope-v${generation}.json`, nativeFixtureRoot)));
  value.kernelArtifact = fixtureKernelArtifact;
  return rebindEnvelope(value);
}

function rebindEnvelope(value) {
  value.journal.plan.planDigest = documentPlanDigest(value.journal.plan);
  value.payloadDigest = documentTransactionPayloadDigest(value.journal);
  value.envelopeDigest = documentTransactionEnvelopeDigest(value);
  return value;
}

for (const generation of [1, 2]) {
  test(`v${generation} current schemas reject native Foundation and kernel-less evidence`, async () => {
    const old = JSON.parse(await readFile(new URL(`old-document-envelope-v${generation}.json`, nativeFixtureRoot)));
    const candidate = JSON.parse(await readFile(new URL(`current-document-envelope-v${generation}.json`, nativeFixtureRoot)));
    await assertSchema(`foundation-transaction-envelope/v${generation + 2}`, old, "frozen-native");
    await assert.rejects(assertDocumentTransactionEnvelope(old));
    await assert.rejects(assertDocumentTransactionEnvelope(candidate));
    const current = await candidateEnvelope(generation);
    await assertDocumentTransactionEnvelope(current);
    await assert.rejects(assertSchema(`foundation-transaction-envelope/v${generation + 2}`, current, "frozen-rejects-current"));
  });

  test(`v${generation} mixed owner tuples fail even with every digest recomputed`, async () => {
    for (const [compiler, handler] of [
      ["@agent-teams/engineering-foundation", "document-authoring"],
      ["@agent-teams/document-authoring", "foundation.document-authoring"],
      ["@agent-teams/engineering-foundation", "foundation.document-authoring"]
    ]) {
      const value = await candidateEnvelope(generation);
      value.journal.plan.compiler.id = compiler;
      value.recoveryHandler.id = handler;
      await assert.rejects(assertDocumentTransactionEnvelope(rebindEnvelope(value)));
    }
  });

  test(`v${generation} kernel coordinates are closed, required and digest-bound`, async () => {
    for (const mutate of [
      (v) => { delete v.kernelArtifact; },
      (v) => { delete v.kernelArtifact.name; },
      (v) => { delete v.kernelArtifact.version; },
      (v) => { delete v.kernelArtifact.buildIdentity; },
      (v) => { v.kernelArtifact.extra = true; },
      (v) => { v.kernelArtifact.name = "@agent-teams/engineering-foundation"; },
      (v) => { v.kernelArtifact.version = "^0.0.0"; },
      (v) => { v.kernelArtifact.version = "0.01.0"; },
      (v) => { v.kernelArtifact.buildIdentity = "sha256:no"; },
      (v) => { v.extra = true; },
      (v) => { v.schemaVersion = String(v.schemaVersion); },
      (v) => { v.journal.plan.schemaVersion = 3; },
      (v) => { v.foundation.version = "9.9.9"; }
    ]) {
      const value = structuredClone(await candidateEnvelope(generation));
      mutate(value);
      await assert.rejects(assertDocumentTransactionEnvelope(rebindEnvelope(value)));
    }
    const digestTamper = structuredClone(await candidateEnvelope(generation));
    digestTamper.kernelArtifact.buildIdentity = `sha256:${"8".repeat(64)}`;
    await assert.rejects(assertDocumentTransactionEnvelope(digestTamper), /digest/u);
  });
}

test("directory envelope requires exact prefix evidence and lifecycle identities", async () => {
  const plan = (await candidateEnvelope(2)).journal.plan;
  const paths = ["packages/example/src/features", "packages/example/src/features/create-widget"];
  plan.parentMaterialization.deepestExistingDirectory = "packages/example/src";
  plan.parentMaterialization.missingDirectories = paths;
  plan.planDigest = documentPlanDigest(plan);
  const materialization = (count) => ({
    schemaVersion: 2, plan: plan.parentMaterialization, anchorIdentity: identity,
    createdDirectories: paths.slice(0, count).map((path, index) => ({ path, identity: { ...identity, ino: String(10 + index) } }))
  });
  const temporary = { path: documentTemporaryPath(plan.destination, plan.planDigest), digest: plan.output.digest, identity };
  const valid = [
    [0, { state: "PREPARED", destination: "pending" }],
    [0, { state: "MATERIALIZING", pendingDirectory: paths[0] }],
    [1, { state: "MATERIALIZING", pendingDirectory: paths[1] }],
    [2, { state: "MATERIALIZING" }],
    [2, { state: "PUBLISHING", temporary }],
    [2, { state: "PUBLISHED", publicationIdentity: identity }]
  ];
  for (const [count, lifecycle] of valid) {
    const envelope = await createDocumentTransactionEnvelope(envelopeBodyV4(plan, fixtureKernelArtifact, materialization(count), lifecycle));
    assert.deepEqual(envelope.kernelArtifact, fixtureKernelArtifact);
    assert.equal(Object.isFrozen(envelope.kernelArtifact), true);
    for (const mutate of [
      (v) => { v.journal.parentMaterialization.anchorIdentity.ino = "0"; },
      (v) => { v.journal.parentMaterialization.anchorIdentity.adapter = "unknown"; },
      (v) => { v.journal.parentMaterialization.extra = true; }
    ]) {
      const invalid = structuredClone(envelope); mutate(invalid);
      await assert.rejects(assertDocumentTransactionEnvelope(rebindEnvelope(invalid)));
    }
  }
  for (const [count, lifecycle] of [
    [1, { state: "PREPARED", destination: "pending" }],
    [1, { state: "PUBLISHING", temporary }],
    [1, { state: "PUBLISHED", publicationIdentity: identity }],
    [0, { state: "MATERIALIZING", pendingDirectory: paths[1] }]
  ]) {
    await assert.rejects(createDocumentTransactionEnvelope(envelopeBodyV4(plan, fixtureKernelArtifact, materialization(count), lifecycle)));
  }
  for (const mutate of [
    (m) => { m.createdDirectories.reverse(); },
    (m) => { m.createdDirectories[0].identity.ino = "0"; },
    (m) => { m.createdDirectories[0].identity.extra = true; }
  ]) {
    const invalid = materialization(2); mutate(invalid);
    await assert.rejects(createDocumentTransactionEnvelope(envelopeBodyV4(plan, fixtureKernelArtifact, invalid, { state: "MATERIALIZING" })));
  }
});

test("current recovery selects the two explicit current catalog IDs", async () => {
  for (const generation of [1, 2]) {
    const calls = [];
    await assertDocumentTransactionEnvelopeWithSchema({
      async assertSchema(name, value, phase) {
        calls.push(name);
        await assertSchema(name, value, phase);
      }
    }, await candidateEnvelope(generation));
    assert.deepEqual(calls, [generation === 1
      ? "document-authoring/document-file-transaction-envelope/v1"
      : "document-authoring/document-directory-transaction-envelope/v1"]);
  }
});

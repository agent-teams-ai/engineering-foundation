import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  canonicalJson,
  sha256Bytes,
  sha256Json,
} from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import {
  parseStrictJson,
  StrictJsonError,
} from "../packages/engineering-foundation/dist/strict-json.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function clone(value) {
  return structuredClone(value);
}

function documentEnvelope() {
  const envelope = clone(fixture.documentEnvelope);
  envelope.journal.plan = clone(fixture.plan);
  return envelope;
}

async function rejectsSchema(schemaId, value) {
  await assert.rejects(
    assertSchema(schemaId, value, "document-authoring-contract-test"),
    (error) => error?.problem?.code === "SCHEMA_INVALID",
  );
}

function bodyWithout(value, digestField) {
  const body = clone(value);
  delete body[digestField];
  return body;
}

test("accepts every document authoring v1 contract fixture", async () => {
  await assertSchema("document-authoring-profile/v1", fixture.profile, "profile");
  await assertSchema("document-intent/v1", fixture.intent, "intent");
  await assertSchema("document-plan/v1", fixture.plan, "plan");
  await assertSchema("document-receipt/v1", fixture.receipt, "receipt");
  await assertSchema(
    "foundation-transaction-envelope/v2",
    documentEnvelope(),
    "transaction-envelope",
  );
  await assertSchema("document-command-envelope/v1", fixture.command, "command");
});

test("freezes canonical JSON and every content-addressed fixture field", () => {
  assert.equal(canonicalJson(fixture.canonical.value), fixture.canonical.json);
  assert.equal(sha256Json(fixture.canonical.value), fixture.canonical.digest);
  assert.equal(sha256Json(fixture.intent), fixture.plan.intentDigest);
  assert.equal(
    sha256Bytes(Buffer.from(fixture.plan.output.contentBase64, "base64")),
    fixture.plan.output.digest,
  );
  assert.equal(
    sha256Json(bodyWithout(fixture.plan, "planDigest")),
    fixture.plan.planDigest,
  );
  assert.equal(
    sha256Json(bodyWithout(fixture.receipt, "receiptDigest")),
    fixture.receipt.receiptDigest,
  );

  const envelope = documentEnvelope();
  assert.equal(sha256Json(envelope.journal), envelope.payloadDigest);
  assert.equal(
    sha256Json(bodyWithout(envelope, "envelopeDigest")),
    envelope.envelopeDigest,
  );
});

test("detects a same-shape Plan digest tamper", async () => {
  const plan = clone(fixture.plan);
  plan.destination = "docs/decisions/0084-tampered.md";
  await assertSchema("document-plan/v1", plan, "tampered-plan-shape");
  assert.notEqual(
    sha256Json(bodyWithout(plan, "planDigest")),
    plan.planDigest,
  );
});

test("rejects unknown versions and fields across the public contracts", async () => {
  for (const [schemaId, source] of [
    ["document-authoring-profile/v1", fixture.profile],
    ["document-intent/v1", fixture.intent],
    ["document-plan/v1", fixture.plan],
    ["document-receipt/v1", fixture.receipt],
    ["document-command-envelope/v1", fixture.command],
  ]) {
    const unknownVersion = clone(source);
    unknownVersion.schemaVersion = 99;
    await rejectsSchema(schemaId, unknownVersion);

    const unknownField = clone(source);
    unknownField.extension = true;
    await rejectsSchema(schemaId, unknownField);
  }

  const futureEnvelope = documentEnvelope();
  futureEnvelope.schemaVersion = 3;
  await rejectsSchema("foundation-transaction-envelope/v2", futureEnvelope);
});

test("keeps profiles local, closed, create-only, and non-executable", async () => {
  const remoteSchema = clone(fixture.profile);
  remoteSchema.catalog.metadataSchemaPath = "https://example.test/metadata.json";
  await rejectsSchema("document-authoring-profile/v1", remoteSchema);

  const hook = clone(fixture.profile);
  hook.authoring.artifactTypes[0].hook = "node scripts/create.mjs";
  await rejectsSchema("document-authoring-profile/v1", hook);

  const unsupportedPlacement = clone(fixture.profile);
  unsupportedPlacement.authoring.artifactTypes[0].placement = {
    kind: "glob",
    pattern: "docs/**/*.md",
  };
  await rejectsSchema("document-authoring-profile/v1", unsupportedPlacement);

  const missingOwnerCatalog = clone(fixture.profile);
  delete missingOwnerCatalog.catalog.ownerCatalog;
  await rejectsSchema("document-authoring-profile/v1", missingOwnerCatalog);

  const devicePath = clone(fixture.profile);
  devicePath.catalog.metadataSchemaPath = "docs/CON.json";
  await rejectsSchema("document-authoring-profile/v1", devicePath);
});

test("bounds inert additional metadata by width, depth, and scalar size", async () => {
  const tooManyRelations = clone(fixture.intent);
  tooManyRelations.related = Array.from({ length: 129 }, (_, index) => `ADR-${index}`);
  await rejectsSchema("document-intent/v1", tooManyRelations);

  const tooDeep = clone(fixture.intent);
  tooDeep.additionalMetadata = { a: { b: { c: { d: { e: true } } } } };
  await rejectsSchema("document-intent/v1", tooDeep);

  const oversized = clone(fixture.intent);
  oversized.title = "x".repeat(241);
  await rejectsSchema("document-intent/v1", oversized);
});

test("binds Receipt result evidence to a proven output outcome", async () => {
  const missingResult = clone(fixture.receipt);
  delete missingResult.resultDigest;
  await rejectsSchema("document-receipt/v1", missingResult);

  const rejectedWithResult = clone(fixture.receipt);
  rejectedWithResult.outcome = "rejected";
  rejectedWithResult.commit = {
    state: "not-published",
    publication: "none",
    atomicity: "not-applicable",
    recoverability: "not-required",
  };
  await rejectsSchema("document-receipt/v1", rejectedWithResult);
});

test("binds transaction payloads to closed Foundation recovery handlers", async () => {
  const mismatchedHandler = documentEnvelope();
  mismatchedHandler.recoveryHandler.id = "foundation.scaffolding";
  await rejectsSchema("foundation-transaction-envelope/v2", mismatchedHandler);

  const unknownPayload = documentEnvelope();
  unknownPayload.payloadKind = "consumer.callback/v1";
  await rejectsSchema("foundation-transaction-envelope/v2", unknownPayload);
});

test("binds each JSON command to its closed result shape", async () => {
  const wrongResult = clone(fixture.command);
  wrongResult.command = "docs.new";
  await rejectsSchema("document-command-envelope/v1", wrongResult);

  const zeroMatches = clone(fixture.command);
  await assertSchema("document-command-envelope/v1", zeroMatches, "zero-matches");
  assert.equal(zeroMatches.result.matches, 0);
  assert.equal(zeroMatches.outcome, "success");
});

test("strict JSON rejects duplicate contract keys before schema validation", () => {
  assert.throws(
    () => parseStrictJson('{"schemaVersion":1,"schemaVersion":1}'),
    (error) =>
      error instanceof StrictJsonError && error.failure === "duplicate-key",
  );
  assert.throws(
    () => parseStrictJson('{"schemaVersion":1,"nested":{"id":"a","id":"b"}}'),
    (error) =>
      error instanceof StrictJsonError && error.failure === "duplicate-key",
  );
});

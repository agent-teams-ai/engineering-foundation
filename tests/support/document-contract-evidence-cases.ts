import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  sha256Bytes,
  parseStrictJson,
  StrictJsonError,
} from "../../packages/repository-mutation/dist/index.js";
import {
  assertDocumentPlanDigests,
  assertDocumentReceiptDigest,
} from "../../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";
import { assertSchema } from "../../packages/document-authoring/dist/document-authoring/adapters/node/schema-catalog.js";
import { createDocumentEnvelopeV3 } from "../fixtures/document-authoring-envelope-v3.mjs";
import { readHistoricalSchema } from "./historical-schema-fixtures.mjs";
import { Ajv2020 } from "ajv/dist/2020.js";
const fixturePath = fileURLToPath(
  new URL("../fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
function clone<T>(value: T): T {
  return structuredClone(value);
}

function documentEnvelope(state = "PREPARED") {
  return createDocumentEnvelopeV3(fixture, state);
}

async function rejectsSchema(schemaId: Parameters<typeof assertSchema>[0], value: unknown) {
  await assert.rejects(
    assertSchema(schemaId, value, "document-authoring-contract-test"),
    (error) =>
      error !== null &&
      typeof error === "object" &&
      "problem" in error &&
      error.problem !== null &&
      typeof error.problem === "object" &&
      "code" in error.problem &&
      error.problem.code === "SCHEMA_INVALID",
  );
}

export function registerDocumentEvidenceCases() {
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

  test("binds transaction payloads to closed Document Authoring recovery handlers", async () => {
    const mismatchedHandler = documentEnvelope();
    mismatchedHandler.recoveryHandler.id = "foundation.scaffolding";
    await rejectsSchema("foundation-transaction-envelope/v3", mismatchedHandler);

    const unknownPayload = documentEnvelope();
    unknownPayload.payloadKind = "consumer.callback/v1";
    await rejectsSchema("foundation-transaction-envelope/v3", unknownPayload);
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
      (error) => error instanceof StrictJsonError && error.failure === "duplicate-key",
    );
    assert.throws(
      () => parseStrictJson('{"schemaVersion":1,"nested":{"id":"a","id":"b"}}'),
      (error) => error instanceof StrictJsonError && error.failure === "duplicate-key",
    );
  });

  test("native archived evidence and the entire frozen Plan/envelope closure remain byte-exact", async () => {
    const root = new URL(
      "../../packages/document-authoring/tests/fixtures/schema-recovery/",
      import.meta.url,
    );
    const origin = JSON.parse(await readFile(new URL("origin.json", root), "utf8"));
    for (const [name, expected] of Object.entries(origin.sha256)) {
      assert.equal(sha256Bytes(await readFile(new URL(name, root))), `sha256:${expected}`, name);
    }
    const historical = new Ajv2020({ strict: true, strictTuples: false, validateFormats: false });
    for (const [name, expected] of Object.entries(origin.frozenSchemaSha256)) {
      const { bytes, schema } = await readHistoricalSchema(name);
      assert.equal(sha256Bytes(bytes), `sha256:${expected}`, name);
      historical.addSchema(schema);
    }
    for (const generation of [1, 2] as const) {
      const plan = JSON.parse(
        await readFile(new URL(`native-old-plan-v${generation}.json`, root), "utf8"),
      );
      const receipt = JSON.parse(
        await readFile(new URL(`native-old-receipt-v${generation}.json`, root), "utf8"),
      );
      assert.equal(
        historical.validate(`https://agent-teams.ai/schemas/document-plan/v${generation}`, plan),
        true,
      );
      assert.equal(
        historical.validate(
          `https://agent-teams.ai/schemas/document-receipt/v${generation}`,
          receipt,
        ),
        true,
      );
      await assertSchema(`document-plan/v${generation}`, plan, "native-old-plan");
      await assertSchema(`document-receipt/v${generation}`, receipt, "native-old-receipt");
      await assert.rejects(
        assertSchema(`document-authoring/document-plan/v${generation}`, plan, "old-plan-refused"),
      );
      const envelope = JSON.parse(
        await readFile(new URL(`native-old-envelope-v${generation}.json`, root), "utf8"),
      );
      assert.equal(
        historical.validate(
          `https://agent-teams.ai/schemas/foundation-transaction-envelope/v${generation + 2}`,
          envelope,
        ),
        true,
      );
      await assertSchema(
        generation === 1
          ? "foundation-transaction-envelope/v3"
          : "foundation-transaction-envelope/v4",
        envelope,
        "native-old-envelope",
      );
      await assert.rejects(
        assertSchema(
          generation === 1
            ? "document-authoring/document-file-transaction-envelope/v1"
            : "document-authoring/document-directory-transaction-envelope/v1",
          envelope,
          "old-envelope-refused",
        ),
      );
      assertDocumentPlanDigests(plan);
      assertDocumentReceiptDigest(receipt, plan);
    }
  });

  test("schema catalog accepts only explicit names and never follows cross-package traversal", async () => {
    const { readDocumentAuthoringSchema } =
      await import("../../packages/document-authoring/dist/index.js");
    for (const name of [
      "../../repository-mutation/schemas/known-file-transaction-plan/v1",
      "../document-plan/v1",
      "__proto__",
      "constructor",
      "document-plan/v99",
    ]) {
      await assert.rejects(
        readDocumentAuthoringSchema(name as Parameters<typeof readDocumentAuthoringSchema>[0]),
        /Unknown Document Authoring schema catalog name/u,
      );
    }
    assert.equal(
      JSON.parse(await readDocumentAuthoringSchema("document-authoring/document-plan/v2")).$id,
      "https://agent-teams.ai/schemas/document-authoring/document-plan/v2",
    );
  });
}

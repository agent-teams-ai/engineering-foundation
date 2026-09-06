import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { inspectLegacyDocumentTransaction } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/legacy-document-transaction-status.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/document-authoring-contracts/legacy-envelope-v2-0.13.1.json", import.meta.url), "utf8"));

test("transaction coordination no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("transaction-coordination");
});

test("source policy rejects a schema assembly import in legacy transaction inspection", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/transaction-coordination/adapters/node/legacy-document-transaction-status.ts",
    "../../../schema-catalog.js"
  );
});

test("known legacy document artifacts use the historical decoder before the current schema callback", async () => {
  const before = JSON.stringify(fixture);
  let validations = 0;
  const status = await inspectLegacyDocumentTransaction(fixture, async () => { validations += 1; throw new Error("current schema cannot reinterpret legacy evidence"); });
  assert.equal(validations, 0);
  assert.equal(status.state, "manual-recovery-required");
  assert.equal(status.reason, "recovery-handler-unavailable");
  assert.equal(status.foundationVersion, "0.13.1");
  assert.equal(status.foundationBuildIdentity, fixture.foundation.buildIdentity);
  assert.equal(JSON.stringify(fixture), before);
});

test("unknown legacy builds delegate the exact v2 schema and preserve failure identity", async () => {
  const input = structuredClone(fixture), calls = [];
  input.foundation.buildIdentity = `sha256:${"e".repeat(64)}`;
  const before = JSON.stringify(input), failure = new Error("exact v2 schema rejection");
  await assert.rejects(inspectLegacyDocumentTransaction(input, async (...args) => { calls.push(args); throw failure; }), (error) => error === failure);
  assert.deepEqual(calls, [["foundation-transaction-envelope/v2", input, "foundation-transaction-slot"]]);
  assert.equal(JSON.stringify(input), before);
});

test("malformed known legacy evidence cannot fall through to the current schema callback", async () => {
  const input = { ...structuredClone(fixture), unexpected: true };
  let validations = 0;
  await assert.rejects(inspectLegacyDocumentTransaction(input, async () => { validations += 1; }));
  assert.equal(validations, 0);
});

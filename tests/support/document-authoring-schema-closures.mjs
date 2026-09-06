import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readHistoricalSchema } from "./historical-schema-fixtures.mjs";

async function reader(current) {
  const names = current ? [
    "document-intent/v1", "document-authoring/document-plan/v1", "document-authoring/document-plan/v2",
    "document-authoring/document-file-transaction-envelope/v1",
    "document-authoring/document-directory-transaction-envelope/v1"
  ] : [
    "document-intent/v1", "document-plan/v1", "document-plan/v2",
    "foundation-transaction-envelope/v3", "foundation-transaction-envelope/v4"
  ];
  names.push("document-receipt/v1", "document-receipt/v2");
  const ajv = new Ajv2020({ strict: true, strictTuples: false, validateFormats: false, allErrors: true });
  for (const name of names) {
    const schema = current
      ? JSON.parse(await readFile(new URL(import.meta.resolve(`@agent-teams/document-authoring/schemas/${name}.schema.json`)), "utf8"))
      : (await readHistoricalSchema(name)).schema;
    ajv.addSchema(schema);
  }
  return (kind, generation, value) => {
    const index = kind === "plan" ? generation : kind === "envelope" ? generation + 2 : generation + 4;
    const validate = ajv.getSchema(`https://agent-teams.ai/schemas/${names[index]}`);
    assert.ok(validate, names[index]);
    return validate(value);
  };
}

export const oldReader = await reader(false);
export const currentReader = await reader(true);

export async function assertNativeHistoricalClosure(generation) {
  for (const kind of ["plan", "envelope"]) {
    const value = JSON.parse(await readFile(new URL(`./native/old-document-${kind}-v${generation}.json`, import.meta.url)));
    assert.equal(oldReader(kind, generation, value), true, `native Foundation ${kind} v${generation}`);
    assert.equal(currentReader(kind, generation, value), false, `current reader rejects Foundation ${kind}`);
  }
  const candidate = JSON.parse(await readFile(new URL(`./native/current-document-envelope-v${generation}.json`, import.meta.url)));
  assert.equal(oldReader("envelope", generation, candidate), false);
  assert.equal(currentReader("envelope", generation, candidate), false);
}

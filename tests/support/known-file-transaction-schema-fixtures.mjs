import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import { readHistoricalSchema } from "./historical-schema-fixtures.mjs";

const requireMutation = createRequire(new URL(
  "../../packages/repository-mutation/package.json", import.meta.url
));
const fixtures = new URL("../fixtures/repository-mutation-known-file/", import.meta.url);

export async function readHistoricalKnownFileFixture(name) {
  const filename = `foundation-0.21.0-${name}.json`;
  const provenance = JSON.parse(await readFile(new URL("foundation-0.21.0-provenance.json", fixtures)));
  const bytes = await readFile(new URL(filename, fixtures));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.files[filename]);
  return { bytes, value: JSON.parse(bytes) };
}

export async function readKnownFileSchema(kind, owner) {
  if (owner === "historical") {return readHistoricalSchema(`known-file-transaction-${kind}/v1`);}
  const prefix = owner === "current" ? "repository-mutation/" : "";
  const bytes = await readFile(requireMutation.resolve(
    `@agent-teams/repository-mutation/schemas/${prefix}known-file-transaction-${kind}/v1.schema.json`
  ));
  return { bytes, schema: JSON.parse(bytes) };
}

export async function assertKnownFileSchemaIdentity(kind, value, owner = "current") {
  const before = JSON.stringify(value);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const candidate of ["historical", "current"]) {
    const { schema } = await readKnownFileSchema(kind, candidate);
    const prefix = candidate === "current" ? "repository-mutation/" : "";
    assert.equal(schema.$id, `https://agent-teams.ai/schemas/${prefix}known-file-transaction-${kind}/v1`);
    // Unique IDs allow both frozen and current contracts in the same registry.
    const validate = ajv.compile(schema);
    assert.equal(validate(value), candidate === owner, JSON.stringify(validate.errors));
    if (candidate !== owner) {
      assert.ok(validate.errors.some((error) => error.instancePath === "/protocol" && error.keyword === "const"));
    }
    for (const invalid of [{ ...value, schemaVersion: 2 }, { ...value, unknown: true }]) {
      assert.equal(validate(invalid), false);
    }
  }
  assert.equal(JSON.stringify(value), before);
}

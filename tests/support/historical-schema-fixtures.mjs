import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("./historical-schemas/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));

// One exact historical closure, never a lookup in the current package catalog.
export async function readHistoricalSchema(name) {
  const path = `${name}.schema.json`;
  assert.equal(Object.hasOwn(manifest.files, path), true, `Unknown historical schema: ${name}`);
  const bytes = await readFile(new URL(path, root));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.files[path]);
  const schema = JSON.parse(bytes);
  assert.equal(schema.$id, `https://agent-teams.ai/schemas/${name}`);
  return { bytes, schema };
}

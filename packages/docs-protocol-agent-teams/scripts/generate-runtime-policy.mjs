import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { runtimePolicySchemaPath, runtimePolicySourcePath } from "./runtime-policy-input-paths.mjs";

const policyUrl = new URL(`../../../${runtimePolicySourcePath}`, import.meta.url);
const schemaUrl = new URL(`../../../${runtimePolicySchemaPath}`, import.meta.url);
const assetUrl = new URL("../assets/runtime-policy.v1.json", import.meta.url);
const assetSchemaUrl = new URL("../schemas/managed-runtime-policy/v1.schema.json", import.meta.url);
const source = await readFile(policyUrl);
const policy = JSON.parse(source.toString("utf8"));
const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
if (!validate(policy)) { throw new Error(`Invalid runtime policy source: ${JSON.stringify(validate.errors)}`); }
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const projection = {
  schemaVersion: 1,
  policyId: policy.policyId,
  policyVersion: policy.policyVersion,
  sourceDigest: digest(source),
  productionDefault: policy.runtime.productionDefault,
  compatibilityLane: policy.runtime.compatibilityLane,
  managedCandidate: policy.managedCandidate,
  managedRuntime: policy.managedRuntime,
};
const output = `${JSON.stringify(projection, null, 2)}\n`;
const assetSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-teams.ai/schemas/managed-runtime-policy/v1",
  title: "Exact packed managed runtime policy projection",
  const: projection,
};
const schemaOutput = `${JSON.stringify(assetSchema, null, 2)}\n`;
if (process.argv.includes("--write")) {
  await writeFile(assetUrl, output);
  await writeFile(assetSchemaUrl, schemaOutput);
} else if (await readFile(assetUrl, "utf8") !== output ||
    await readFile(assetSchemaUrl, "utf8") !== schemaOutput) {
  throw new Error("Packed runtime policy projection or schema is stale.");
}

import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { DocsProfileError } from "../../application/profile-policy.js";

const validatorPromises = new Map<3 | 4, Promise<ValidateFunction>>();

async function validator(version: 3 | 4): Promise<ValidateFunction> {
  const existing = validatorPromises.get(version);
  if (existing !== undefined) {return existing;}
  const created = (async () => {
    const schemaUrl = new URL(`../../../../../schemas/docs-protocol-profile/v${version}.schema.json`, import.meta.url);
    const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats.default(ajv);
    return ajv.compile(schema);
  })();
  validatorPromises.set(version, created);
  return created;
}

export async function assertDocsProtocolProfileSchema(value: unknown): Promise<void> {
  const declared = typeof value === "object" && value !== null && "schemaVersion" in value
    ? (value as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (declared !== 3 && declared !== 4) {
    throw new DocsProfileError("Portable profile must declare docs-protocol-profile/v3 or v4.");
  }
  const validate = await validator(declared);
  if (validate(value)) {
    return;
  }
  const problems = (validate.errors ?? [])
    .slice(0, 8)
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
  throw new DocsProfileError(`Profile does not match docs-protocol-profile/v${declared}: ${problems}`);
}

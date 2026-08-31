import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

const validatorPromises = new Map<1 | 2 | 3, Promise<ValidateFunction>>();

async function validator(version: 1 | 2 | 3): Promise<ValidateFunction> {
  const existing = validatorPromises.get(version);
  if (existing !== undefined) {return existing;}
  const loading = (async () => {
    const schemaUrl = new URL(`../../schemas/docs-protocol-portable-command-envelope/v${version}.schema.json`, import.meta.url);
    const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    return ajv.compile(schema);
  })();
  validatorPromises.set(version, loading);
  return loading;
}

export async function assertDocsCommandEnvelopeSchema(value: unknown): Promise<void> {
  const version = typeof value === "object" && value !== null && "schemaVersion" in value
    ? (value as { readonly schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new TypeError("Command output must declare docs-protocol-command-envelope schemaVersion 1, 2, or 3.");
  }
  const validate = await validator(version);
  if (validate(value)) {return;}
  const problems = (validate.errors ?? [])
    .slice(0, 8)
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
  throw new TypeError(`Command output does not match docs-protocol-portable-command-envelope/v${version}: ${problems}`);
}

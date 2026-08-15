import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

let validatorPromise: Promise<ValidateFunction> | undefined;

async function validator(): Promise<ValidateFunction> {
  validatorPromise ??= (async () => {
    const schemaUrl = new URL("../../schemas/docs-protocol-command-envelope/v1.schema.json", import.meta.url);
    const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
    return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  })();
  return validatorPromise;
}

export async function assertDocsCommandEnvelopeSchema(value: unknown): Promise<void> {
  const validate = await validator();
  if (validate(value)) {return;}
  const problems = (validate.errors ?? [])
    .slice(0, 8)
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
  throw new TypeError(`Command output does not match docs-protocol-command-envelope/v1: ${problems}`);
}

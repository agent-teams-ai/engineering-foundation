import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020.js";

import { CapabilityInputError } from "./capability-runtime.js";
import {
  FOUNDATION_SCHEMA_IDS,
  type FoundationSchemaId
} from "./schema-ids.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const validators = new Map<FoundationSchemaId, ValidateFunction>();

export function isFoundationSchemaId(value: string): value is FoundationSchemaId {
  return FOUNDATION_SCHEMA_IDS.some((candidate) => candidate === value);
}

function schemaPath(schemaId: FoundationSchemaId): string {
  return join(packageRoot, "schemas", `${schemaId}.schema.json`);
}

export async function readFoundationSchema(
  schemaId: FoundationSchemaId
): Promise<string> {
  return readFile(schemaPath(schemaId), "utf8");
}

function safeValidationMessage(errors: readonly ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return "Input does not match the required schema.";
  }
  return errors
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
}

async function validator(schemaId: FoundationSchemaId): Promise<ValidateFunction> {
  const cached = validators.get(schemaId);
  if (cached !== undefined) {
    return cached;
  }
  const schema = JSON.parse(await readFoundationSchema(schemaId)) as object;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false
  });
  const compiled = ajv.compile(schema);
  validators.set(schemaId, compiled);
  return compiled;
}

export async function assertSchema(
  schemaId: FoundationSchemaId,
  input: unknown,
  phase: string
): Promise<void> {
  const validate = await validator(schemaId);
  if (!validate(input)) {
    throw new CapabilityInputError({
      code: "SCHEMA_INVALID",
      message: safeValidationMessage(validate.errors),
      phase,
      retryable: false
    });
  }
}

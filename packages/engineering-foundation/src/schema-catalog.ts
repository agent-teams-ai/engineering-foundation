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
  type FoundationSchemaCatalogId,
  type FoundationSchemaId
} from "./schema-ids.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // Canonical schemas use open prefix tuples; strictTuples rejects that valid
  // Draft 2020-12 shape as a style warning rather than a validation error.
  strictTuples: false,
  validateFormats: false
});
const validators = new Map<FoundationSchemaCatalogId, ValidateFunction>();
const schemaLoads = new Map<string, Promise<string>>();
const SCHEMA_DEPENDENCIES: Partial<
  Readonly<Record<FoundationSchemaCatalogId, readonly FoundationSchemaCatalogId[]>>
> = {
  "document-plan/v1": ["document-intent/v1"],
  "foundation-transaction-envelope/v2": [
    "document-intent/v1",
    "document-plan/v1",
    "scaffold-plan/v1",
    "scaffold-recovery-journal/v1"
  ],
  "scaffold-recovery-journal/v1": ["scaffold-plan/v1"]
};

export function isFoundationSchemaId(value: string): value is FoundationSchemaId {
  return FOUNDATION_SCHEMA_IDS.some((candidate) => candidate === value);
}

function schemaPath(schemaId: FoundationSchemaCatalogId): string {
  return join(packageRoot, "schemas", `${schemaSource(schemaId)}.schema.json`);
}

function schemaSource(schemaId: FoundationSchemaCatalogId): string {
  return schemaId;
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

async function loadSchema(schemaId: FoundationSchemaCatalogId): Promise<string> {
  for (const dependency of SCHEMA_DEPENDENCIES[schemaId] ?? []) {
    await registerSchema(dependency);
  }
  const schema = JSON.parse(await readFile(schemaPath(schemaId), "utf8")) as {
    readonly $id?: unknown;
  };
  if (typeof schema.$id !== "string" || schema.$id.length === 0) {
    throw new Error(`Foundation schema ${schemaId} must declare a non-empty $id.`);
  }
  if (ajv.getSchema(schema.$id) === undefined) {
    ajv.addSchema(schema as Parameters<Ajv2020["addSchema"]>[0]);
  }
  return schema.$id;
}

function registerSchema(schemaId: FoundationSchemaCatalogId): Promise<string> {
  const source = schemaSource(schemaId);
  const existing = schemaLoads.get(source);
  if (existing !== undefined) {
    return existing;
  }
  const loading = loadSchema(schemaId);
  schemaLoads.set(source, loading);
  return loading;
}

async function validator(
  schemaId: FoundationSchemaCatalogId
): Promise<ValidateFunction> {
  const cached = validators.get(schemaId);
  if (cached !== undefined) {
    return cached;
  }
  const schemaKey = await registerSchema(schemaId);
  const compiled = ajv.getSchema(schemaKey);
  if (compiled === undefined) {
    throw new Error(`Foundation schema ${schemaId} is not registered.`);
  }
  validators.set(schemaId, compiled);
  return compiled;
}

export async function assertSchema(
  schemaId: FoundationSchemaCatalogId,
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

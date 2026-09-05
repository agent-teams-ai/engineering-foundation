import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { rejectSchemaInput } from "../../../application/configuration-file-problem.js";
import type { SchemaCatalog, SchemaCatalogInput } from "../../../application/schema-catalog.js";

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

export function createSchemaCatalog<SchemaId extends string>(
  catalogInput: SchemaCatalogInput<SchemaId>
): SchemaCatalog<SchemaId> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    // Canonical schemas use open prefix tuples; strictTuples rejects that valid
    // Draft 2020-12 shape as a style warning rather than a validation error.
    strictTuples: false,
    validateFormats: false
  });
  const validators = new Map<SchemaId, ValidateFunction>();
  const schemaLoads = new Map<string, Promise<string>>();
  async function loadSchema(schemaId: string): Promise<string> {
    for (const dependency of catalogInput.dependencies[schemaId] ?? []) {
      await registerSchema(dependency);
    }
    const source = await catalogInput.readSchema(schemaId);
    const schema = JSON.parse(source) as {
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

  function registerSchema(schemaId: string): Promise<string> {
    const source = schemaId;
    const existing = schemaLoads.get(source);
    if (existing !== undefined) {
      return existing;
    }
    const loading = loadSchema(schemaId);
    schemaLoads.set(source, loading);
    return loading;
  }

  async function validator(
    schemaId: SchemaId
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

  async function assertSchema(
    schemaId: SchemaId,
    input: unknown,
    phase: string
  ): Promise<void> {
    const validate = await validator(schemaId);
    if (!validate(input)) {
      rejectSchemaInput(safeValidationMessage(validate.errors), phase);
    }
  }

  return {
    assertSchema,
    isSchemaId(value: string): value is SchemaId {
      return catalogInput.schemaIds.some((candidate) => candidate === value);
    },
    readSchema: catalogInput.readSchema
  };
}

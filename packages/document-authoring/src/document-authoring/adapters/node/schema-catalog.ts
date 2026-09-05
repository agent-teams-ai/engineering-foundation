import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { CapabilityInputError } from "../../../documentation-observation/api.js";

import type { DocumentAuthoringSchemaId } from "../../application/ports/document-schema-validator.js";

const dependencies: Record<DocumentAuthoringSchemaId, readonly DocumentAuthoringSchemaId[]> = {
  "document-authoring-profile/v1": [],
  "document-authoring-profile/v2": ["document-authoring-profile/v1"],
  "document-authoring-profile/v3": ["document-authoring-profile/v1"],
  "document-command-envelope/v1": [],
  "document-command-envelope/v2": [],
  "document-intent/v1": [],
  "document-parent-materialization/v2": [],
  "document-plan/v1": ["document-intent/v1"],
  "document-plan/v2": ["document-intent/v1", "document-plan/v1"],
  "document-authoring/document-plan/v1": ["document-intent/v1"],
  "document-authoring/document-plan/v2": ["document-intent/v1", "document-authoring/document-plan/v1"],
  "document-authoring/document-file-transaction-envelope/v1": [
    "document-intent/v1", "document-authoring/document-plan/v1"
  ],
  "document-authoring/document-directory-transaction-envelope/v1": [
    "document-intent/v1", "document-authoring/document-plan/v1",
    "document-authoring/document-plan/v2", "document-authoring/document-file-transaction-envelope/v1"
  ],
  "document-receipt/v1": [],
  "document-receipt/v2": ["document-receipt/v1"],
  "foundation-transaction-envelope/v3": ["document-intent/v1", "document-plan/v1"],
  "foundation-transaction-envelope/v4": [
    "document-intent/v1", "document-plan/v1", "document-plan/v2",
    "foundation-transaction-envelope/v3"
  ]
};
const packageRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTuples: false, validateFormats: false });
const validators = new Map<DocumentAuthoringSchemaId, ValidateFunction>();
const loads = new Map<DocumentAuthoringSchemaId, Promise<string>>();

export function readDocumentAuthoringSchema(
  schemaId: DocumentAuthoringSchemaId
): Promise<string> {
  if (!Object.hasOwn(dependencies, schemaId)) {
    return Promise.reject(new TypeError("Unknown Document Authoring schema catalog name."));
  }
  return readFile(join(packageRoot, "schemas", `${schemaId}.schema.json`), "utf8");
}

function safeMessage(errors: readonly ErrorObject[] | null | undefined): string {
  if (errors === undefined || errors === null || errors.length === 0) {
    return "Input does not match the required schema.";
  }
  return errors.slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ").slice(0, 1000);
}

async function register(id: DocumentAuthoringSchemaId): Promise<string> {
  const cached = loads.get(id);
  if (cached !== undefined) {
    return cached;
  }
  const loading = (async () => {
    for (const dependency of dependencies[id]) {
      await register(dependency);
    }
    const schema = JSON.parse(await readDocumentAuthoringSchema(id)) as {
      readonly $id?: unknown;
    };
    if (schema.$id !== `https://agent-teams.ai/schemas/${id}`) {
      throw new Error(`Document Authoring schema ${id} must declare its exact catalog $id.`);
    }
    ajv.addSchema(schema as Parameters<Ajv2020["addSchema"]>[0]);
    return schema.$id;
  })();
  loads.set(id, loading);
  return loading;
}

export async function assertSchema(
  schemaId: DocumentAuthoringSchemaId, input: unknown, phase: string
): Promise<void> {
  let validate = validators.get(schemaId);
  if (validate === undefined) {
    const key = await register(schemaId);
    validate = ajv.getSchema(key);
    if (validate === undefined) {
      throw new Error(`Document Authoring schema ${schemaId} is not registered.`);
    }
    validators.set(schemaId, validate);
  }
  if (!validate(input)) {
    throw new CapabilityInputError({
      code: "SCHEMA_INVALID", message: safeMessage(validate.errors), phase, retryable: false
    });
  }
}

import { assertNotCancelled, type ContainedFileReader } from "../../../documentation-observation/api.js";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";


import { parseStrictJson, StrictJsonError } from "@agent-teams/repository-mutation/serialization";
import type {
  MetadataInstanceValidator,
  MetadataSchemaSnapshot,
  MetadataValidationResult
} from "../../application/ports/metadata-instance-validator.js";
import { DocumentCatalogError } from "../../application/model/document-catalog-error.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAX_METADATA_SCHEMA_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSchema(message: string, cause?: unknown): never {
  throw new DocumentCatalogError(
    "DOCUMENT_CATALOG_INPUT_INVALID",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function assertLocalReferences(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertLocalReferences(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && (typeof item !== "string" || !item.startsWith("#"))) {
      invalidSchema("Document metadata schema may use only local fragment $ref values.");
    }
    if (["$async", "$dynamicRef", "$recursiveRef"].includes(key)) {
      invalidSchema(
        "Document metadata schema may not use async, dynamic, or recursive validation."
      );
    }
    assertLocalReferences(item);
  }
}

function messages(errors: readonly ErrorObject[] | null | undefined): readonly string[] {
  return Object.freeze(
    (errors ?? [])
      .slice(0, 16)
      .map((error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`.slice(0, 1000)
      )
  );
}

export class NodeMetadataInstanceValidator implements MetadataInstanceValidator {
  constructor(private readonly readFile: ContainedFileReader) {}
  async load(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<MetadataSchemaSnapshot> {
    assertNotCancelled(request.signal);
    const file = await readDocumentAuthorityFile(this.readFile, {
      consumerRoot: request.consumerRoot,
      maxBytes: MAX_METADATA_SCHEMA_BYTES,
      path: request.path
    });
    assertNotCancelled(request.signal);
    let schema: unknown;
    try {
      schema = parseStrictJson(file.source);
    } catch (error) {
      if (error instanceof StrictJsonError) {
        invalidSchema("Document metadata schema must contain strict JSON.", error);
      }
      throw error;
    }
    if (!isRecord(schema)) {
      invalidSchema("Document metadata schema must be a JSON object.");
    }
    assertLocalReferences(schema);
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictTuples: false,
      validateFormats: false
    });
    let validate;
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      invalidSchema("Document metadata schema cannot be compiled as Draft 2020-12.", error);
    }
    assertNotCancelled(request.signal);
    return Object.freeze({
      evidence: file.evidence,
      ...(Array.isArray(schema["required"]) &&
      schema["required"].every((item) => typeof item === "string")
        ? {
            requiredProperties: Object.freeze(
              [...new Set(schema["required"])].toSorted()
            )
          }
        : {}),
      validate(instance: unknown): MetadataValidationResult {
        const valid = validate(instance);
        return Object.freeze({ messages: messages(validate.errors), valid });
      }
    });
  }
}

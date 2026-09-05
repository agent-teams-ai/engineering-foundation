import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import { QUERY_FIELDS } from "./input-schemas.js";
import { objectRecord, standardJsonSchema } from "./schema.js";
import { DOCS_PROTOCOL_MCP_PROJECTION_VERSION, MAX_INFO_CATALOG_COLLECTIONS, MAX_INFO_TYPES, MAX_RESULTS } from "./tool-contracts.js";

function countedOutputSchema(items: Readonly<Record<string, unknown>>, maximum: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["originalCount", "returnedCount", "truncated", "items"]),
    properties: Object.freeze({
      originalCount: Object.freeze({ type: "integer", minimum: 0 }),
      returnedCount: Object.freeze({ type: "integer", minimum: 0, maximum }),
      truncated: Object.freeze({ type: "boolean" }),
      items: Object.freeze({ type: "array", maxItems: maximum, items })
    })
  });
}

const STRING_OUTPUT_SCHEMA = Object.freeze({ type: "string" });
const COUNTED_STRINGS_8_OUTPUT_SCHEMA = countedOutputSchema(STRING_OUTPUT_SCHEMA, 8);
const COUNTED_STRINGS_16_OUTPUT_SCHEMA = countedOutputSchema(STRING_OUTPUT_SCHEMA, 16);
const COUNTED_STRINGS_32_OUTPUT_SCHEMA = countedOutputSchema(STRING_OUTPUT_SCHEMA, 32);

const DIAGNOSTICS_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["originalCount", "returnedCount", "truncated", "items"]),
  properties: Object.freeze({
    originalCount: Object.freeze({ type: "integer", minimum: 0 }),
    returnedCount: Object.freeze({ type: "integer", minimum: 0, maximum: 8 }),
    truncated: Object.freeze({ type: "boolean" }),
    items: Object.freeze({
      type: "array",
      maxItems: 8,
      items: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: Object.freeze(Object.fromEntries(["ruleId", "severity", "phase", "subject", "message"]
          .map((field) => [field, Object.freeze({ type: "string" })])))
      })
    })
  })
});

function projectionOutputJsonSchema(command: string, result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["schemaVersion", "source", "diagnostics", "result"]),
    properties: Object.freeze({
      schemaVersion: Object.freeze({ const: DOCS_PROTOCOL_MCP_PROJECTION_VERSION }),
      source: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze(["protocol", "command", "outcome", "exitCode"]),
        properties: Object.freeze({
          protocol: Object.freeze({
            type: "object",
            additionalProperties: false,
            properties: Object.freeze({ id: Object.freeze({ type: "string" }), version: Object.freeze({ type: "integer" }) })
          }),
          command: Object.freeze({ const: command }),
          outcome: Object.freeze({ type: "string" }),
          exitCode: Object.freeze({ type: "integer" })
        })
      }),
      diagnostics: DIAGNOSTICS_OUTPUT_SCHEMA,
      result
    })
  });
}

const INFO_RESULT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["kind", "protocol", "foundationProfile", "agentWorkflow", "catalog", "authorityPaths", "ownerIds", "types", "semanticValidatorIds"]),
  properties: Object.freeze({
    kind: Object.freeze({ const: "info" }),
    projectId: Object.freeze({ type: "string" }),
    protocol: Object.freeze({ type: "object", additionalProperties: false, properties: Object.freeze({ id: Object.freeze({ type: "string" }), version: Object.freeze({ type: "integer" }) }) }),
    foundationProfile: Object.freeze({ type: "object", additionalProperties: false, properties: Object.freeze({ schemaVersion: Object.freeze({ type: "integer" }), path: Object.freeze({ type: "string" }), metadataSidecarPolicy: Object.freeze({ type: "string" }) }) }),
    agentWorkflow: Object.freeze({ type: "object", additionalProperties: false, properties: Object.freeze({ skillPath: Object.freeze({ type: "string" }), adoption: Object.freeze({ type: "string" }) }) }),
    catalog: Object.freeze({
      type: "object", additionalProperties: false, required: Object.freeze(["collections", "excludedPrefixes"]), properties: Object.freeze({
        collections: countedOutputSchema(Object.freeze({ type: "object", additionalProperties: false, required: Object.freeze(["roots"]), properties: Object.freeze({ kind: Object.freeze({ type: "string" }), root: Object.freeze({ type: "string" }), roots: COUNTED_STRINGS_16_OUTPUT_SCHEMA }) }), MAX_INFO_CATALOG_COLLECTIONS),
        excludedPrefixes: COUNTED_STRINGS_16_OUTPUT_SCHEMA
      })
    }),
    semanticDigest: Object.freeze({ type: "string" }),
    metadataSchemaPath: Object.freeze({ type: "string" }),
    authorityPaths: COUNTED_STRINGS_16_OUTPUT_SCHEMA,
    ownerIds: COUNTED_STRINGS_32_OUTPUT_SCHEMA,
    types: countedOutputSchema(Object.freeze({ type: "object", additionalProperties: false, required: Object.freeze(["allowedOwnerIds", "requiredMetadata"]), properties: Object.freeze({ type: Object.freeze({ type: "string" }), initialStatus: Object.freeze({ type: "string" }), allowedOwnerIds: COUNTED_STRINGS_8_OUTPUT_SCHEMA, requiredMetadata: COUNTED_STRINGS_8_OUTPUT_SCHEMA }) }), MAX_INFO_TYPES),
    semanticValidatorIds: COUNTED_STRINGS_32_OUTPUT_SCHEMA
  })
});

const FIND_RESULT_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: Object.freeze(["kind", "originalCount", "returnedCount", "truncated", "documents"]), properties: Object.freeze({
    kind: Object.freeze({ const: "find" }), originalCount: Object.freeze({ type: "integer", minimum: 0 }), returnedCount: Object.freeze({ type: "integer", minimum: 0 }), truncated: Object.freeze({ type: "boolean" }),
    documents: Object.freeze({ type: "array", maxItems: MAX_RESULTS, items: Object.freeze({ type: "object", additionalProperties: false, required: Object.freeze(["related", "blockedBy"]), properties: Object.freeze({
      ...Object.fromEntries(["id", "type", "status", "owner", "title", "summary", "repositoryPath", "source"].map((field) => [field, Object.freeze({ type: "string" })])),
      related: COUNTED_STRINGS_8_OUTPUT_SCHEMA, blockedBy: COUNTED_STRINGS_8_OUTPUT_SCHEMA
    }) }) })
  })
});

const CONTEXT_RESULT_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: Object.freeze(["kind", "format", "selection", "limits"]), properties: Object.freeze({
    kind: Object.freeze({ const: "context" }), format: Object.freeze({ const: "llms.txt" }), projectId: Object.freeze({ type: "string" }), catalogSemanticDigest: Object.freeze({ type: "string" }),
    selection: Object.freeze({ type: "object", additionalProperties: false, required: Object.freeze(["ranking", "query"]), properties: Object.freeze({ ranking: Object.freeze({ enum: Object.freeze(["binary-default", "fuzzy-advisory"]) }), query: Object.freeze({ type: "object", additionalProperties: false, properties: Object.freeze(Object.fromEntries(QUERY_FIELDS.map((field) => [field, Object.freeze({ type: "string" })]))) }) }) }),
    limits: Object.freeze({ type: "object", additionalProperties: false, properties: Object.freeze({ maxBytes: Object.freeze({ type: "integer" }), maxDocuments: Object.freeze({ type: "integer" }) }) }),
    includedDocuments: Object.freeze({ type: "integer" }), omittedDocuments: Object.freeze({ type: "integer" }), truncated: Object.freeze({ type: "boolean" }), content: Object.freeze({ type: "string" })
  })
});

export const DOCS_INFO_OUTPUT_SCHEMA_V1 = projectionOutputJsonSchema("docs.info", INFO_RESULT_OUTPUT_SCHEMA);
export const DOCS_FIND_OUTPUT_SCHEMA_V1 = projectionOutputJsonSchema("docs.find", FIND_RESULT_OUTPUT_SCHEMA);
export const DOCS_CONTEXT_OUTPUT_SCHEMA_V1 = projectionOutputJsonSchema("docs.context", CONTEXT_RESULT_OUTPUT_SCHEMA);
export const DOCS_ERROR_OUTPUT_SCHEMA_V1 = Object.freeze({
  type: "object", additionalProperties: false, required: Object.freeze(["error"]), properties: Object.freeze({ error: Object.freeze({ type: "object", additionalProperties: false, required: Object.freeze(["code", "message"]), properties: Object.freeze({ code: Object.freeze({ enum: Object.freeze(["CANCELLED", "DOCS_READ_FAILED", "RESULT_TOO_LARGE"]) }), message: Object.freeze({ type: "string" }) }) }) })
});

function projectionSchema(jsonSchema: Readonly<Record<string, unknown>>, command: string): StandardSchemaWithJSON<unknown, Readonly<Record<string, unknown>>> {
  return standardJsonSchema(jsonSchema, (value) => {
    const projection = objectRecord(value);
    const source = objectRecord(projection.source);
    return projection.schemaVersion === DOCS_PROTOCOL_MCP_PROJECTION_VERSION && source.command === command && Array.isArray(objectRecord(projection.diagnostics).items) && typeof projection.result === "object" && projection.result !== null
      ? Object.freeze({ value: projection })
      : Object.freeze({ issues: Object.freeze([{ message: "Invalid MCP projection output." }]) });
  });
}

export const INFO_OUTPUT_SCHEMA = projectionSchema(DOCS_INFO_OUTPUT_SCHEMA_V1, "docs.info");
export const FIND_OUTPUT_SCHEMA = projectionSchema(DOCS_FIND_OUTPUT_SCHEMA_V1, "docs.find");
export const CONTEXT_OUTPUT_SCHEMA = projectionSchema(DOCS_CONTEXT_OUTPUT_SCHEMA_V1, "docs.context");


// oxlint-disable eslint/max-lines -- Closed transport schemas stay co-located with the deterministic projections they validate.
import type { CallToolResult, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
import type { DocsFindQuery, DocsFindQueryV3 } from "@agent-teams/docs-protocol";

import type { DocsBinding, DocsReadExecution, DocsReader } from "./contracts.js";
import { recordOrIssue, standardJsonSchema, unknownKeys } from "./schema.js";
import { DOCS_PROTOCOL_MCP_PROJECTION_VERSION } from "./version.js";

const MAX_RESULT_BYTES = 262_144;
const DEFAULT_MAX_RESULTS = 25;
const MAX_RESULTS = 100;
const DEFAULT_CONTEXT_MAX_BYTES = 32_768;
const DEFAULT_CONTEXT_MAX_DOCUMENTS = 10;
const MAX_CONTEXT_BYTES = 131_072;
const MAX_CONTEXT_DOCUMENTS = 50;
const MAX_INFO_AUTHORITY_PATHS = 16;
const MAX_INFO_CATALOG_COLLECTIONS = 16;
const MAX_INFO_CATALOG_PATHS = 16;
const MAX_INFO_OWNERS = 32;
const MAX_INFO_TYPES = 24;
const MAX_INFO_TYPE_FIELDS = 8;
const MAX_INFO_VALIDATORS = 32;
const MAX_FIND_RELATIONS = 8;
const MAX_FIND_PROJECTION_BYTES = 196_608;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;
const OPAQUE_ID_SCHEMA_PATTERN = "^[A-Za-z0-9@][A-Za-z0-9@._/-]*$";
const LOWER_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/u;
const LOWER_ID_SCHEMA_PATTERN = "^[a-z0-9][a-z0-9._/-]*$";
const TEXT_SCHEMA_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F\\uD800-\\uDFFF]+$";
const OPAQUE_QUERY_FIELDS = new Set(["blockedBy", "id", "owner", "related"]);
const LOWER_QUERY_FIELDS = new Set(["status", "type"]);
const FIND_FIELDS = Object.freeze(["blockedBy", "fuzzy", "id", "maxResults", "owner", "related", "status", "text", "type"] as const);
const FIND_FIELD_SET = new Set<string>(FIND_FIELDS);
const QUERY_FIELDS = Object.freeze(["blockedBy", "id", "owner", "related", "status", "text", "type"] as const);
const CONTEXT_FIELDS = Object.freeze(["blockedBy", "fuzzy", "id", "maxBytes", "maxDocuments", "owner", "related", "status", "text", "type"] as const);
const CONTEXT_FIELD_SET = new Set<string>(CONTEXT_FIELDS);
const QUERY_REQUIREMENT_JSON = Object.freeze(QUERY_FIELDS.map((field) => Object.freeze({ required: Object.freeze([field]) })));
const FUZZY_REQUIRES_TEXT_JSON = Object.freeze({
  if: Object.freeze({
    properties: Object.freeze({ fuzzy: Object.freeze({ const: true }) }),
    required: Object.freeze(["fuzzy"])
  }),
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the JSON Schema conditional keyword.
  then: Object.freeze({ required: Object.freeze(["text"]) })
});

interface InputIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
}

function validatedQueryFields(
  record: Readonly<Record<string, unknown>>,
  issues: InputIssue[]
): Readonly<{ output: Record<string, string | number | boolean>; queryFields: number }> {
  const output: Record<string, string | number | boolean> = {};
  let queryFields = 0;
  for (const field of QUERY_FIELDS) {
    const candidate = record[field];
    if (candidate === undefined) {continue;}
    const candidateString = typeof candidate === "string" ? candidate : undefined;
    const valid = field === "text"
      ? candidateString !== undefined && candidateString.length >= 1 && candidateString.length <= 512 && !hasControlCharacter(candidateString)
      : OPAQUE_QUERY_FIELDS.has(field)
        ? candidateString !== undefined && candidateString.length <= 214 && OPAQUE_ID_PATTERN.test(candidateString)
        : LOWER_QUERY_FIELDS.has(field) && candidateString !== undefined && candidateString.length <= 160 && LOWER_ID_PATTERN.test(candidateString);
    if (!valid) {
      issues.push(Object.freeze({ message: "Query field has an invalid value or exceeds its canonical limit.", path: Object.freeze([field]) }));
      continue;
    }
    output[field] = candidateString!;
    queryFields += 1;
  }
  return Object.freeze({ output, queryFields });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {return true;}
  }
  return false;
}

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

const INFO_OUTPUT_SCHEMA = projectionSchema(DOCS_INFO_OUTPUT_SCHEMA_V1, "docs.info");
const FIND_OUTPUT_SCHEMA = projectionSchema(DOCS_FIND_OUTPUT_SCHEMA_V1, "docs.find");
const CONTEXT_OUTPUT_SCHEMA = projectionSchema(DOCS_CONTEXT_OUTPUT_SCHEMA_V1, "docs.context");

export interface DocsFindArguments extends DocsFindQuery {
  readonly fuzzy?: boolean;
  readonly maxResults?: number;
}

export interface DocsContextArguments extends Omit<DocsFindQuery, "ranking"> {
  readonly fuzzy?: boolean;
  readonly maxBytes?: number;
  readonly maxDocuments?: number;
}

export interface DocsTool<Arguments extends object> {
  readonly name: "docs_context" | "docs_find" | "docs_info";
  readonly description: string;
  readonly inputSchema: StandardSchemaWithJSON<unknown, Arguments>;
  readonly annotations: ToolAnnotations;
  run(arguments_: Arguments, signal: AbortSignal): Promise<CallToolResult>;
}

interface RegisteredDocsTool<Arguments extends object> extends DocsTool<Arguments> {
  readonly outputSchema: StandardSchemaWithJSON<unknown, Readonly<Record<string, unknown>>>;
}

const READ_ONLY_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

const EMPTY_SCHEMA = standardJsonSchema<Readonly<Record<string, never>>>(
  Object.freeze({ type: "object", additionalProperties: false, maxProperties: 0 }),
  (value) => {
    const parsed = recordOrIssue(value);
    if ("issues" in parsed) {return parsed;}
    const issues = unknownKeys(parsed.record, new Set());
    return issues.length === 0
      ? Object.freeze({ value: Object.freeze({}) })
      : Object.freeze({ issues });
  }
);

const FIND_SCHEMA_JSON = Object.freeze({
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  anyOf: QUERY_REQUIREMENT_JSON,
  allOf: Object.freeze([FUZZY_REQUIRES_TEXT_JSON]),
  properties: Object.freeze({
    text: Object.freeze({ type: "string", minLength: 1, maxLength: 512, pattern: TEXT_SCHEMA_PATTERN }),
    id: Object.freeze({ type: "string", minLength: 1, maxLength: 214, pattern: OPAQUE_ID_SCHEMA_PATTERN }),
    type: Object.freeze({ type: "string", minLength: 1, maxLength: 160, pattern: LOWER_ID_SCHEMA_PATTERN }),
    status: Object.freeze({ type: "string", minLength: 1, maxLength: 160, pattern: LOWER_ID_SCHEMA_PATTERN }),
    owner: Object.freeze({ type: "string", minLength: 1, maxLength: 214, pattern: OPAQUE_ID_SCHEMA_PATTERN }),
    related: Object.freeze({ type: "string", minLength: 1, maxLength: 214, pattern: OPAQUE_ID_SCHEMA_PATTERN }),
    blockedBy: Object.freeze({ type: "string", minLength: 1, maxLength: 214, pattern: OPAQUE_ID_SCHEMA_PATTERN }),
    fuzzy: Object.freeze({ type: "boolean" }),
    maxResults: Object.freeze({ type: "integer", minimum: 1, maximum: MAX_RESULTS })
  })
});

const FIND_SCHEMA = standardJsonSchema<DocsFindArguments>(FIND_SCHEMA_JSON, (value) => {
  const parsed = recordOrIssue(value);
  if ("issues" in parsed) {return parsed;}
  const issues = [...unknownKeys(parsed.record, FIND_FIELD_SET)];
  const { output, queryFields } = validatedQueryFields(parsed.record, issues);
  const maxResults = parsed.record.maxResults;
  if (maxResults !== undefined) {
    if (!Number.isInteger(maxResults) || typeof maxResults !== "number" || maxResults < 1 || maxResults > MAX_RESULTS) {
      issues.push(Object.freeze({ message: `Expected an integer from 1 to ${MAX_RESULTS}.`, path: Object.freeze(["maxResults"]) }));
    } else {
      output.maxResults = maxResults;
    }
  }
  const fuzzy = parsed.record.fuzzy;
  if (fuzzy !== undefined) {
    if (typeof fuzzy !== "boolean") {
      issues.push(Object.freeze({ message: "Expected a boolean.", path: Object.freeze(["fuzzy"]) }));
    } else {
      output.fuzzy = fuzzy;
    }
  }
  if (fuzzy === true && typeof output.text !== "string") {
    issues.push(Object.freeze({ message: "Fuzzy ranking requires text.", path: Object.freeze(["fuzzy"]) }));
  }
  if (queryFields === 0) {
    issues.push(Object.freeze({ message: "At least one documentation query field is required." }));
  }
  return issues.length === 0
    ? Object.freeze({ value: Object.freeze(output) as DocsFindArguments })
    : Object.freeze({ issues: Object.freeze(issues) });
});

const CONTEXT_SCHEMA_JSON = Object.freeze({
  type: "object",
  additionalProperties: false,
  allOf: Object.freeze([FUZZY_REQUIRES_TEXT_JSON]),
  properties: Object.freeze({
    text: Object.freeze({ type: "string", minLength: 1, maxLength: 512, pattern: TEXT_SCHEMA_PATTERN }),
    id: Object.freeze({ type: "string", minLength: 1, maxLength: 214, pattern: OPAQUE_ID_SCHEMA_PATTERN }),
    type: Object.freeze({ type: "string", minLength: 1, maxLength: 160, pattern: LOWER_ID_SCHEMA_PATTERN }),
    status: Object.freeze({ type: "string", minLength: 1, maxLength: 160, pattern: LOWER_ID_SCHEMA_PATTERN }),
    owner: Object.freeze({ type: "string", minLength: 1, maxLength: 214, pattern: OPAQUE_ID_SCHEMA_PATTERN }),
    related: Object.freeze({ type: "string", minLength: 1, maxLength: 214, pattern: OPAQUE_ID_SCHEMA_PATTERN }),
    blockedBy: Object.freeze({ type: "string", minLength: 1, maxLength: 214, pattern: OPAQUE_ID_SCHEMA_PATTERN }),
    fuzzy: Object.freeze({ type: "boolean" }),
    maxDocuments: Object.freeze({ type: "integer", minimum: 1, maximum: MAX_CONTEXT_DOCUMENTS }),
    maxBytes: Object.freeze({ type: "integer", minimum: 1_024, maximum: MAX_CONTEXT_BYTES })
  })
});

const CONTEXT_SCHEMA = standardJsonSchema<DocsContextArguments>(CONTEXT_SCHEMA_JSON, (value) => {
  const parsed = recordOrIssue(value);
  if ("issues" in parsed) {return parsed;}
  const issues = [...unknownKeys(parsed.record, CONTEXT_FIELD_SET)];
  const { output } = validatedQueryFields(parsed.record, issues);
  for (const [field, minimum, maximum] of [
    ["maxDocuments", 1, MAX_CONTEXT_DOCUMENTS],
    ["maxBytes", 1_024, MAX_CONTEXT_BYTES]
  ] as const) {
    const candidate = parsed.record[field];
    if (candidate === undefined) {continue;}
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
      issues.push(Object.freeze({ message: `Expected an integer from ${minimum} to ${maximum}.`, path: Object.freeze([field]) }));
    } else {
      output[field] = candidate;
    }
  }
  const fuzzy = parsed.record.fuzzy;
  if (fuzzy !== undefined && typeof fuzzy !== "boolean") {
    issues.push(Object.freeze({ message: "Expected a boolean.", path: Object.freeze(["fuzzy"]) }));
  } else if (fuzzy === true && typeof output.text !== "string") {
    issues.push(Object.freeze({ message: "Fuzzy ranking requires text.", path: Object.freeze(["fuzzy"]) }));
  } else if (fuzzy !== undefined) {
    output.fuzzy = fuzzy;
  }
  return issues.length === 0
    ? Object.freeze({ value: Object.freeze(output) as DocsContextArguments })
    : Object.freeze({ issues: Object.freeze(issues) });
});

function errorResult(code: "CANCELLED" | "DOCS_READ_FAILED" | "RESULT_TOO_LARGE", message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(Object.freeze({ error: Object.freeze({ code, message }) })) }]
  };
}

function successResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    return errorResult("RESULT_TOO_LARGE", "The documentation result exceeds the MCP response limit; narrow the query.");
  }
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value as Record<string, unknown>
  };
}

function sanitizedFailure(error: unknown, signal: AbortSignal): CallToolResult {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return errorResult("CANCELLED", "The documentation read was cancelled.");
  }
  return errorResult("DOCS_READ_FAILED", "The documentation read failed.");
}

function queryFrom(arguments_: DocsFindArguments | DocsContextArguments): DocsFindQueryV3 {
  const query: Record<string, string> = {};
  for (const field of QUERY_FIELDS) {
    const value = arguments_[field];
    if (value !== undefined) {query[field] = value;}
  }
  return Object.freeze({
    ...query,
    ...(arguments_.fuzzy === true ? { ranking: "fuzzy-advisory" as const } : {})
  });
}

function projectExecution(execution: DocsReadExecution, result: unknown): Readonly<Record<string, unknown>> {
  const protocol = objectRecord(execution.envelope.protocol);
  return Object.freeze({
    schemaVersion: DOCS_PROTOCOL_MCP_PROJECTION_VERSION,
    source: Object.freeze({
      protocol: Object.freeze({
        ...(stringValue(protocol.id) === undefined ? {} : { id: protocol.id }),
        ...(typeof protocol.version !== "number" ? {} : { version: protocol.version })
      }),
      command: execution.envelope.command,
      outcome: execution.envelope.outcome,
      exitCode: execution.exitCode
    }),
    diagnostics: projectDiagnostics(execution.envelope.diagnostics),
    result
  });
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : Object.freeze([]);
}

function boundedStrings(value: unknown, maximum: number): Readonly<Record<string, unknown>> {
  const original = stringList(value);
  const items = Object.freeze(original.slice(0, maximum));
  return Object.freeze({
    originalCount: original.length,
    returnedCount: items.length,
    truncated: items.length < original.length,
    items
  });
}

function projectDiagnostics(value: readonly unknown[]): Readonly<Record<string, unknown>> {
  const items = Object.freeze(value.slice(0, 8).map((entry) => {
    const record = objectRecord(entry);
    return Object.freeze({
      ...(stringValue(record.ruleId) === undefined ? {} : { ruleId: record.ruleId }),
      ...(stringValue(record.severity) === undefined ? {} : { severity: record.severity }),
      ...(stringValue(record.phase) === undefined ? {} : { phase: record.phase }),
      ...(stringValue(record.subject) === undefined ? {} : { subject: record.subject }),
      ...(stringValue(record.message) === undefined ? {} : { message: record.message })
    });
  }));
  return Object.freeze({
    originalCount: value.length,
    returnedCount: items.length,
    truncated: items.length < value.length,
    items
  });
}

function projectCatalog(value: unknown): Readonly<Record<string, unknown>> {
  const catalog = objectRecord(value);
  const originalCollections = Array.isArray(catalog.collections) ? catalog.collections : [];
  const collections = Object.freeze(originalCollections.slice(0, MAX_INFO_CATALOG_COLLECTIONS).map((entry) => {
    const collection = objectRecord(entry);
    return Object.freeze({
      ...(stringValue(collection.kind) === undefined ? {} : { kind: collection.kind }),
      ...(stringValue(collection.root) === undefined ? {} : { root: collection.root }),
      roots: boundedStrings(collection.roots, MAX_INFO_CATALOG_PATHS)
    });
  }));
  return Object.freeze({
    collections: Object.freeze({
      originalCount: originalCollections.length,
      returnedCount: collections.length,
      truncated: collections.length < originalCollections.length,
      items: collections
    }),
    excludedPrefixes: boundedStrings(catalog.excludedPrefixes, MAX_INFO_CATALOG_PATHS)
  });
}

function projectInfo(execution: DocsReadExecution): Readonly<Record<string, unknown>> {
  const result = objectRecord(execution.envelope.result);
  const profile = objectRecord(result.foundationProfile);
  const workflow = objectRecord(result.agentWorkflow);
  const protocol = objectRecord(result.protocol);
  const originalTypes = Array.isArray(result.types) ? result.types : [];
  const types = Object.freeze(originalTypes.slice(0, MAX_INFO_TYPES).map((value) => {
    const type = objectRecord(value);
    return Object.freeze({
      ...(stringValue(type.type) === undefined ? {} : { type: type.type }),
      ...(stringValue(type.initialStatus) === undefined ? {} : { initialStatus: type.initialStatus }),
      allowedOwnerIds: boundedStrings(type.allowedOwnerIds, MAX_INFO_TYPE_FIELDS),
      requiredMetadata: boundedStrings(type.requiredMetadata, MAX_INFO_TYPE_FIELDS)
    });
  }));
  return projectExecution(execution, Object.freeze({
    kind: "info",
    ...(stringValue(result.projectId) === undefined ? {} : { projectId: result.projectId }),
    protocol: Object.freeze({
      ...(stringValue(protocol.id) === undefined ? {} : { id: protocol.id }),
      ...(typeof protocol.version !== "number" ? {} : { version: protocol.version })
    }),
    foundationProfile: Object.freeze({
      ...(typeof profile.schemaVersion !== "number" ? {} : { schemaVersion: profile.schemaVersion }),
      ...(stringValue(profile.path) === undefined ? {} : { path: profile.path }),
      ...(stringValue(profile.metadataSidecarPolicy) === undefined ? {} : { metadataSidecarPolicy: profile.metadataSidecarPolicy })
    }),
    agentWorkflow: Object.freeze({
      ...(stringValue(workflow.skillPath) === undefined ? {} : { skillPath: workflow.skillPath }),
      ...(stringValue(workflow.adoption) === undefined ? {} : { adoption: workflow.adoption })
    }),
    catalog: projectCatalog(result.catalog),
    ...(stringValue(result.semanticDigest) === undefined ? {} : { semanticDigest: result.semanticDigest }),
    ...(stringValue(result.metadataSchemaPath) === undefined ? {} : { metadataSchemaPath: result.metadataSchemaPath }),
    authorityPaths: boundedStrings(result.authorityPaths, MAX_INFO_AUTHORITY_PATHS),
    ownerIds: boundedStrings(result.ownerIds, MAX_INFO_OWNERS),
    types: Object.freeze({
      originalCount: originalTypes.length,
      returnedCount: types.length,
      truncated: types.length < originalTypes.length,
      items: types
    }),
    semanticValidatorIds: boundedStrings(result.semanticValidatorIds, MAX_INFO_VALIDATORS)
  }));
}

function projectFindDocument(value: unknown): Readonly<Record<string, unknown>> {
  const document = objectRecord(value);
  return Object.freeze({
    ...Object.fromEntries(["id", "type", "status", "owner", "title", "summary", "repositoryPath", "source"]
      .flatMap((field) => stringValue(document[field]) === undefined ? [] : [[field, document[field]]])),
    related: boundedStrings(document.related, MAX_FIND_RELATIONS),
    blockedBy: boundedStrings(document.blockedBy, MAX_FIND_RELATIONS)
  });
}

function projectContext(execution: DocsReadExecution): Readonly<Record<string, unknown>> {
  const result = objectRecord(execution.envelope.result);
  const limits = objectRecord(result.limits);
  const selection = objectRecord(result.selection);
  const selectionQuery = objectRecord(selection.query);
  return projectExecution(execution, Object.freeze({
    kind: "context",
    format: "llms.txt",
    ...(stringValue(result.projectId) === undefined ? {} : { projectId: result.projectId }),
    ...(stringValue(result.catalogSemanticDigest) === undefined ? {} : { catalogSemanticDigest: result.catalogSemanticDigest }),
    selection: Object.freeze({
      ranking: selection.ranking === "fuzzy-advisory" ? "fuzzy-advisory" : "binary-default",
      query: Object.freeze(Object.fromEntries(QUERY_FIELDS.flatMap((field) =>
        stringValue(selectionQuery[field]) === undefined ? [] : [[field, selectionQuery[field]]])))
    }),
    limits: Object.freeze({
      ...(typeof limits.maxBytes !== "number" ? {} : { maxBytes: limits.maxBytes }),
      ...(typeof limits.maxDocuments !== "number" ? {} : { maxDocuments: limits.maxDocuments })
    }),
    ...(typeof result.includedDocuments !== "number" ? {} : { includedDocuments: result.includedDocuments }),
    ...(typeof result.omittedDocuments !== "number" ? {} : { omittedDocuments: result.omittedDocuments }),
    ...(typeof result.truncated !== "boolean" ? {} : { truncated: result.truncated }),
    ...(stringValue(result.content) === undefined ? {} : { content: result.content })
  }));
}

function boundedFindProjection(execution: DocsReadExecution, maxResults: number): Readonly<Record<string, unknown>> {
  const result = execution.envelope.result;
  if (typeof result !== "object" || result === null || !("documents" in result) || !Array.isArray(result.documents)) {
    return projectExecution(execution, result);
  }
  const originalCount = result.documents.length;
  const documents: Readonly<Record<string, unknown>>[] = [];
  for (const value of result.documents.slice(0, maxResults)) {
    const document = projectFindDocument(value);
    const candidate = projectExecution(execution, Object.freeze({
      kind: "find",
      originalCount,
      returnedCount: documents.length + 1,
      truncated: documents.length + 1 < originalCount,
      documents: Object.freeze([...documents, document])
    }));
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_FIND_PROJECTION_BYTES) {break;}
    documents.push(document);
  }
  return projectExecution(execution, Object.freeze({
    kind: "find",
    originalCount,
    returnedCount: documents.length,
    truncated: documents.length < originalCount,
    documents: Object.freeze(documents)
  }));
}

export function createDocsTools(reader: DocsReader, binding: DocsBinding): readonly [
  DocsTool<Readonly<Record<string, never>>>,
  DocsTool<DocsFindArguments>,
  DocsTool<DocsContextArguments>
] {
  const fixedBinding = Object.freeze({ ...binding });
  const tools: readonly [
    RegisteredDocsTool<Readonly<Record<string, never>>>,
    RegisteredDocsTool<DocsFindArguments>,
    RegisteredDocsTool<DocsContextArguments>
  ] = Object.freeze([
    Object.freeze({
      name: "docs_info" as const,
      description: "Read the fixed consumer's documentation protocol, authority, catalog, owners, and document types.",
      inputSchema: EMPTY_SCHEMA,
      outputSchema: INFO_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      async run(_arguments: Readonly<Record<string, never>>, signal: AbortSignal) {
        try {
          signal.throwIfAborted();
          const execution = await reader.info({ ...fixedBinding, signal });
          return successResult(projectInfo(execution));
        } catch (error: unknown) {
          return sanitizedFailure(error, signal);
        }
      }
    }),
    Object.freeze({
      name: "docs_find" as const,
      description: "Search the fixed consumer's documentation catalog with bounded, read-only filters.",
      inputSchema: FIND_SCHEMA,
      outputSchema: FIND_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      async run(arguments_: DocsFindArguments, signal: AbortSignal) {
        try {
          signal.throwIfAborted();
          const execution = await reader.find({ ...fixedBinding, query: queryFrom(arguments_), signal });
          return successResult(boundedFindProjection(execution, arguments_.maxResults ?? DEFAULT_MAX_RESULTS));
        } catch (error: unknown) {
          return sanitizedFailure(error, signal);
        }
      }
    }),
    Object.freeze({
      name: "docs_context" as const,
      description: "Build bounded llms.txt context from the fixed consumer's documentation with optional filters and advisory fuzzy ranking.",
      inputSchema: CONTEXT_SCHEMA,
      outputSchema: CONTEXT_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      async run(arguments_: DocsContextArguments, signal: AbortSignal) {
        try {
          signal.throwIfAborted();
          const execution = await reader.context({
            ...fixedBinding,
            query: queryFrom(arguments_),
            limits: Object.freeze({
              maxBytes: arguments_.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES,
              maxDocuments: arguments_.maxDocuments ?? DEFAULT_CONTEXT_MAX_DOCUMENTS
            }),
            signal
          });
          return successResult(projectContext(execution));
        } catch (error: unknown) {
          return sanitizedFailure(error, signal);
        }
      }
    })
  ] as const);
  return tools;
}

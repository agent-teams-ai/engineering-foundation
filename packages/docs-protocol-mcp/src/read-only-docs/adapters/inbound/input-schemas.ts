import { recordOrIssue, standardJsonSchema, unknownKeys } from "./schema.js";
import { MAX_RESULTS, MAX_CONTEXT_BYTES, MAX_CONTEXT_DOCUMENTS, type DocsFindArguments, type DocsContextArguments } from "./tool-contracts.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;
const OPAQUE_ID_SCHEMA_PATTERN = "^[A-Za-z0-9@][A-Za-z0-9@._/-]*$";
const LOWER_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/u;
const LOWER_ID_SCHEMA_PATTERN = "^[a-z0-9][a-z0-9._/-]*$";
const TEXT_SCHEMA_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F\\uD800-\\uDFFF]+$";
const OPAQUE_QUERY_FIELDS = new Set(["blockedBy", "id", "owner", "related"]);
const LOWER_QUERY_FIELDS = new Set(["status", "type"]);
const FIND_FIELDS = Object.freeze(["blockedBy", "fuzzy", "id", "maxResults", "owner", "related", "status", "text", "type"] as const);
const FIND_FIELD_SET = new Set<string>(FIND_FIELDS);
export const QUERY_FIELDS = Object.freeze(["blockedBy", "id", "owner", "related", "status", "text", "type"] as const);
const CONTEXT_FIELDS = Object.freeze(["blockedBy", "fuzzy", "id", "maxBytes", "maxDocuments", "owner", "related", "status", "text", "type"] as const);
const CONTEXT_FIELD_SET = new Set<string>(CONTEXT_FIELDS);
const QUERY_REQUIREMENT_JSON = Object.freeze(QUERY_FIELDS.map((field) => Object.freeze({ required: Object.freeze([field]) })));
// Keep the conditional as JSON data: "then" is a schema keyword, not a Promise method.
const FUZZY_REQUIRES_TEXT_JSON = JSON.parse(
  '{"if":{"properties":{"fuzzy":{"const":true}},"required":["fuzzy"]},"then":{"required":["text"]}}',
  (_key: string, value: unknown) => typeof value === "object" && value !== null ? Object.freeze(value) : value
) as Readonly<Record<string, unknown>>;

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

export const EMPTY_SCHEMA = standardJsonSchema<Readonly<Record<string, never>>>(
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

export const FIND_SCHEMA = standardJsonSchema<DocsFindArguments>(FIND_SCHEMA_JSON, (value) => {
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
    ? Object.freeze({ value: Object.freeze(output) })
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

export const CONTEXT_SCHEMA = standardJsonSchema<DocsContextArguments>(CONTEXT_SCHEMA_JSON, (value) => {
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
    ? Object.freeze({ value: Object.freeze(output) })
    : Object.freeze({ issues: Object.freeze(issues) });
});


import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError,assertNotCancelled } from "../../../../../features/validation-reporting/api.js";
import { ContainedFileReadError, assertRepositoryRelativePath } from "../../../../../source-inventory/api.js";
import { readContainedRegularFile } from "../../../../../source-inventory/node.js";

import { parseStrictJson, StrictJsonError } from "../../../../../strict-json.js";
import type {
  JsonSchemaDigest,
  JsonSchemaFixture,
  JsonSchemaFixtureResult,
  JsonSchemaInspection
} from "../../../application/model/json-schema-release.js";
import type { JsonSchemaReleaseInspector } from "../../../application/ports/json-schema-release-inspector.js";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const FIXTURE_ID = /^[a-z][a-z0-9.-]{1,119}$/u;

interface SchemaDocument {
  readonly id: string;
  readonly path: string;
  readonly value: Record<string, unknown>;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "json-schema-release-inspection",
    retryable: false
  });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError("JSON_SCHEMA_DOCUMENT_INVALID", `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function digest(value: string): JsonSchemaDigest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      inputError("JSON_SCHEMA_VALUE_INVALID", "JSON evidence cannot contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
      compareBinaryStrings(left, right)
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  inputError("JSON_SCHEMA_VALUE_INVALID", "JSON evidence contains an unsupported value.");
}

type JsonEvidenceReader = (repositoryPath: string) => Promise<Buffer | undefined>;

async function safeJsonFile(
  root: string,
  repositoryPath: string,
  evidenceReader?: JsonEvidenceReader
): Promise<unknown> {
  assertRepositoryRelativePath(repositoryPath, "json-schema-release-inspection");
  if (!repositoryPath.endsWith(".json")) {
    inputError("JSON_SCHEMA_PATH_INVALID", `JSON evidence path must end with .json: ${repositoryPath}.`);
  }
  let bytes: Buffer;
  if (evidenceReader !== undefined) {
    const observed = await evidenceReader(repositoryPath);
    if (observed === undefined) {
      inputError("JSON_SCHEMA_FILE_UNAVAILABLE", `JSON evidence is unavailable: ${repositoryPath}.`);
    }
    if (observed.byteLength > MAX_JSON_BYTES) {
      inputError("JSON_SCHEMA_FILE_INVALID", `JSON evidence is not a supported file: ${repositoryPath}.`);
    }
    bytes = observed;
  } else {
  try {
    bytes = await readContainedRegularFile({
      candidate: resolve(root, repositoryPath),
      maxBytes: MAX_JSON_BYTES,
      root
    });
  } catch (error) {
    if (error instanceof ContainedFileReadError) {
      if (error.failure === "escape") {
        inputError("JSON_SCHEMA_PATH_ESCAPE", `JSON evidence escapes the consumer root: ${repositoryPath}.`);
      }
      if (error.failure === "symlink") {
        inputError(
          "JSON_SCHEMA_SYMLINK_PROHIBITED",
          `JSON evidence cannot traverse a symbolic link: ${repositoryPath}.`
        );
      }
      if (error.failure === "invalid") {
        inputError("JSON_SCHEMA_FILE_INVALID", `JSON evidence is not a supported file: ${repositoryPath}.`);
      }
      inputError("JSON_SCHEMA_FILE_UNAVAILABLE", `JSON evidence is unavailable: ${repositoryPath}.`);
    }
    throw error;
  }
  }
  try {
    return parseStrictJson(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof StrictJsonError && error.failure === "duplicate-key") {
      inputError(
        "JSON_SCHEMA_DUPLICATE_KEY",
        `JSON evidence contains a duplicate object key: ${repositoryPath}.`
      );
    }
    inputError("JSON_SCHEMA_FILE_INVALID", `JSON evidence is invalid: ${repositoryPath}.`);
  }
}

function schemaId(value: Record<string, unknown>, path: string): string {
  const id = value["$id"];
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 500 ||
    id.includes("#") ||
    hasControlCharacter(id)
  ) {
    inputError("JSON_SCHEMA_ID_INVALID", `Schema must have an absolute fragment-free $id: ${path}.`);
  }
  try {
    const parsedId = new URL(id);
    if (parsedId.protocol.length === 0) {
      inputError("JSON_SCHEMA_ID_INVALID", `Schema $id must be an absolute URI: ${path}.`);
    }
  } catch {
    inputError("JSON_SCHEMA_ID_INVALID", `Schema $id must be an absolute URI: ${path}.`);
  }
  return id;
}

function referenceBase(reference: string, sourceId: string): string {
  if (reference.length === 0 || reference.length > 1000 || hasControlCharacter(reference)) {
    inputError("JSON_SCHEMA_REFERENCE_INVALID", "JSON Schema reference is invalid.");
  }
  try {
    return new URL(reference, sourceId).toString().split("#", 1)[0] ?? "";
  } catch {
    inputError("JSON_SCHEMA_REFERENCE_INVALID", "JSON Schema reference cannot be resolved.");
  }
}

function nestedSchemaId(value: unknown, inheritedId: string): string {
  if (typeof value !== "string") {
    inputError("JSON_SCHEMA_ID_INVALID", "Nested schema $id must be a string URI-reference.");
  }
  if (
    value.length === 0 ||
    value.length > 500 ||
    value.includes("#") ||
    hasControlCharacter(value)
  ) {
    inputError(
      "JSON_SCHEMA_ID_INVALID",
      "Nested schema $id must be a non-empty fragment-free URI-reference."
    );
  }
  try {
    return new URL(value, inheritedId).toString();
  } catch {
    inputError("JSON_SCHEMA_ID_INVALID", "Nested schema $id cannot be resolved.");
  }
}

const SINGLE_SCHEMA_KEYWORDS = Object.freeze([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties"
]);
const SCHEMA_ARRAY_KEYWORDS = Object.freeze(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYWORDS = Object.freeze([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties"
]);

function assertReferenceKeyword(
  schema: Readonly<Record<string, unknown>>,
  key: "$dynamicRef" | "$ref",
  sourceId: string,
  knownSchemaIds: ReadonlySet<string>
): void {
  const entry = schema[key];
  if (entry === undefined) {
    return;
  }
  if (typeof entry !== "string") {
    inputError("JSON_SCHEMA_REFERENCE_INVALID", `${key} must be a string.`);
  }
  const target = referenceBase(entry, sourceId);
  if (!knownSchemaIds.has(target)) {
    inputError(
      "JSON_SCHEMA_REFERENCE_NOT_LOCAL",
      `Schema ${sourceId} references a schema not declared in this local contract set.`
    );
  }
}

function schemaMapValues(value: unknown): readonly unknown[] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.values(value as Record<string, unknown>)
    : [];
}

function schemaChildren(schema: Readonly<Record<string, unknown>>): readonly unknown[] {
  const children: unknown[] = [];
  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      children.push(schema[keyword]);
    }
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const entries = schema[keyword];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        children.push(entry as unknown);
      }
    }
  }
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    children.push(...schemaMapValues(schema[keyword]));
  }
  for (const entry of schemaMapValues(schema["dependencies"])) {
    if (!Array.isArray(entry)) {
      children.push(entry);
    }
  }
  return children;
}

function collectNestedSchemaIds(
  value: unknown,
  inheritedId: string,
  knownSchemaIds: Set<string>,
  documentRoot = false
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const schema = value as Record<string, unknown>;
  const currentId =
    documentRoot || schema["$id"] === undefined
      ? inheritedId
      : nestedSchemaId(schema["$id"], inheritedId);
  if (!documentRoot && schema["$id"] !== undefined) {
    if (knownSchemaIds.has(currentId)) {
      inputError(
        "JSON_SCHEMA_ID_DUPLICATE",
        `Schema resource $id values must be unique within a contract: ${currentId}.`
      );
    }
    knownSchemaIds.add(currentId);
  }
  for (const child of schemaChildren(schema)) {
    collectNestedSchemaIds(child, currentId, knownSchemaIds);
  }
}

function assertLocalReferences(
  value: unknown,
  sourceId: string,
  knownSchemaIds: ReadonlySet<string>,
  documentRoot = false
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const schema = value as Record<string, unknown>;
  const currentId =
    documentRoot || schema["$id"] === undefined
      ? sourceId
      : nestedSchemaId(schema["$id"], sourceId);
  for (const key of ["$ref", "$dynamicRef"] as const) {
    assertReferenceKeyword(schema, key, currentId, knownSchemaIds);
  }
  for (const child of schemaChildren(schema)) {
    assertLocalReferences(child, currentId, knownSchemaIds);
  }
}

function assertFixtures(
  fixtures: readonly JsonSchemaFixture[],
  requireMixedExpectations: boolean
): void {
  const ids = new Set<string>();
  const expectations = new Set<JsonSchemaFixture["expectation"]>();
  for (const fixture of fixtures) {
    if (!FIXTURE_ID.test(fixture.id) || ids.has(fixture.id)) {
      inputError("JSON_SCHEMA_FIXTURE_INVALID", "Fixture IDs must be unique normalized identifiers.");
    }
    ids.add(fixture.id);
    assertRepositoryRelativePath(fixture.path, "json-schema-release-inspection");
    const expectation: unknown = fixture.expectation;
    if (expectation !== "valid" && expectation !== "invalid") {
      inputError("JSON_SCHEMA_FIXTURE_INVALID", `Fixture expectation is invalid: ${fixture.id}.`);
    }
    expectations.add(expectation);
    if (typeof fixture.schemaId !== "string" || fixture.schemaId.length === 0) {
      inputError("JSON_SCHEMA_FIXTURE_INVALID", `Fixture schemaId is invalid: ${fixture.id}.`);
    }
  }
  if (
    requireMixedExpectations &&
    (!expectations.has("valid") || !expectations.has("invalid"))
  ) {
    inputError(
      "JSON_SCHEMA_FIXTURE_CORPUS_INCOMPLETE",
      "Fixture corpus must contain at least one valid and one invalid example."
    );
  }
}

function compileSchemas(documents: readonly SchemaDocument[]): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true
  });
  addFormats.default(ajv);
  try {
    for (const document of documents) {
      ajv.addSchema(document.value, document.id);
    }
    for (const document of documents) {
      ajv.getSchema(document.id);
      ajv.compile(document.value);
    }
  } catch {
    inputError("JSON_SCHEMA_COMPILE_FAILED", "AJV strict 2020-12 could not compile the local schema set.");
  }
  return ajv;
}

function schemaSetDigest(documents: readonly SchemaDocument[]): JsonSchemaDigest {
  return digest(
    canonicalJson(
      documents
        .map((document) => ({ id: document.id, schema: document.value }))
        .toSorted((left, right) => compareBinaryStrings(left.id, right.id))
    )
  );
}

function fixtureCorpusDigest(
  fixtures: readonly JsonSchemaFixture[],
  values: ReadonlyMap<string, unknown>
): JsonSchemaDigest {
  return digest(
    canonicalJson(
      fixtures
        .map((fixture) => ({
          id: fixture.id,
          schemaId: fixture.schemaId,
          expectation: fixture.expectation,
          value: values.get(fixture.id)
        }))
        .toSorted((left, right) => compareBinaryStrings(left.id, right.id))
    )
  );
}

export class AjvJsonSchemaReleaseInspector implements JsonSchemaReleaseInspector {
  constructor(private readonly evidenceReader?: JsonEvidenceReader) {}

  async inspect(input: {
    readonly consumerRoot: string;
    readonly schemaPaths: readonly string[];
    readonly fixtures: readonly JsonSchemaFixture[];
    readonly requireMixedExpectations?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<JsonSchemaInspection> {
    assertNotCancelled(input.signal);
    if (input.schemaPaths.length === 0 || input.schemaPaths.length > 1_000) {
      inputError("JSON_SCHEMA_PATHS_INVALID", "Contract must declare between one and 1000 schemas.");
    }
    if (new Set(input.schemaPaths).size !== input.schemaPaths.length) {
      inputError("JSON_SCHEMA_PATHS_INVALID", "Contract schema paths must be unique.");
    }
    assertFixtures(input.fixtures, input.requireMixedExpectations ?? true);
    const root = await realpath(input.consumerRoot).catch(() =>
      inputError("CONSUMER_ROOT_UNAVAILABLE", "Consumer root must be an existing accessible directory.")
    );
    if (!(await stat(root)).isDirectory()) {
      inputError("CONSUMER_ROOT_INVALID", "Consumer root must be a directory.");
    }
    const documents: SchemaDocument[] = [];
    for (const path of input.schemaPaths.toSorted(compareBinaryStrings)) {
      assertNotCancelled(input.signal);
      const value = record(
        await safeJsonFile(root, path, this.evidenceReader),
        `schema ${path}`
      );
      if (value["$schema"] !== DRAFT_2020_12) {
        inputError(
          "JSON_SCHEMA_DIALECT_INVALID",
          `Schema must declare JSON Schema draft 2020-12: ${path}.`
        );
      }
      documents.push({ id: schemaId(value, path), path, value });
    }
    const schemaIds = documents.map((document) => document.id);
    if (new Set(schemaIds).size !== schemaIds.length) {
      inputError("JSON_SCHEMA_ID_DUPLICATE", "Schema $id values must be unique within a contract.");
    }
    const knownSchemaIds = new Set(schemaIds);
    for (const document of documents) {
      collectNestedSchemaIds(document.value, document.id, knownSchemaIds, true);
    }
    for (const document of documents) {
      assertLocalReferences(document.value, document.id, knownSchemaIds, true);
    }
    const ajv = compileSchemas(documents);
    const fixtureValues = new Map<string, unknown>();
    const fixtureResults: JsonSchemaFixtureResult[] = [];
    for (const fixture of input.fixtures.toSorted((left, right) =>
      compareBinaryStrings(left.id, right.id)
    )) {
      assertNotCancelled(input.signal);
      const value = await safeJsonFile(root, fixture.path, this.evidenceReader);
      fixtureValues.set(fixture.id, value);
      const validate = ajv.getSchema(fixture.schemaId) as ValidateFunction | undefined;
      if (validate === undefined) {
        inputError(
          "JSON_SCHEMA_FIXTURE_SCHEMA_UNKNOWN",
          `Fixture ${fixture.id} references a schema outside the local contract set.`
        );
      }
      const valid = validate(value);
      fixtureResults.push({
        id: fixture.id,
        expectation: fixture.expectation,
        matched: fixture.expectation === "valid" ? valid : !valid
      });
    }
    const output = {
      schemaSetDigest: schemaSetDigest(documents),
      fixtureCorpusDigest: fixtureCorpusDigest(input.fixtures, fixtureValues),
      schemaIds: Object.freeze(schemaIds.toSorted(compareBinaryStrings)),
      fixtureResults: Object.freeze(fixtureResults.map((result) => Object.freeze(result)))
    } as const;
    if (!SHA256_DIGEST.test(output.schemaSetDigest) || !SHA256_DIGEST.test(output.fixtureCorpusDigest)) {
      inputError("JSON_SCHEMA_DIGEST_INVALID", "Internal JSON Schema digest generation failed.");
    }
    return Object.freeze(output);
  }
}

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { pathTraversesSymbolicLink } from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled, assertRepositoryRelativePath } from "../../../../../strict-yaml.js";
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

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
      compareStrings(left, right)
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  inputError("JSON_SCHEMA_VALUE_INVALID", "JSON evidence contains an unsupported value.");
}

async function safeJsonFile(root: string, repositoryPath: string): Promise<unknown> {
  assertRepositoryRelativePath(repositoryPath, "json-schema-release-inspection");
  if (!repositoryPath.endsWith(".json")) {
    inputError("JSON_SCHEMA_PATH_INVALID", `JSON evidence path must end with .json: ${repositoryPath}.`);
  }
  const candidate = resolve(root, repositoryPath);
  if (await pathTraversesSymbolicLink(root, candidate)) {
    inputError(
      "JSON_SCHEMA_SYMLINK_PROHIBITED",
      `JSON evidence cannot traverse a symbolic link: ${repositoryPath}.`
    );
  }
  const canonical = await realpath(candidate).catch(() =>
    inputError("JSON_SCHEMA_FILE_UNAVAILABLE", `JSON evidence is unavailable: ${repositoryPath}.`)
  );
  if (!contained(root, canonical)) {
    inputError("JSON_SCHEMA_PATH_ESCAPE", `JSON evidence escapes the consumer root: ${repositoryPath}.`);
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile() || metadata.size > MAX_JSON_BYTES) {
    inputError("JSON_SCHEMA_FILE_INVALID", `JSON evidence is not a supported file: ${repositoryPath}.`);
  }
  try {
    return JSON.parse(await readFile(canonical, "utf8")) as unknown;
  } catch {
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

function assertLocalReferences(
  value: unknown,
  sourceId: string,
  knownSchemaIds: ReadonlySet<string>
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      assertLocalReferences(entry, sourceId, knownSchemaIds);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" || key === "$dynamicRef") {
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
    assertLocalReferences(entry, sourceId, knownSchemaIds);
  }
}

function assertFixtures(fixtures: readonly JsonSchemaFixture[]): void {
  const ids = new Set<string>();
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
    if (typeof fixture.schemaId !== "string" || fixture.schemaId.length === 0) {
      inputError("JSON_SCHEMA_FIXTURE_INVALID", `Fixture schemaId is invalid: ${fixture.id}.`);
    }
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
        .toSorted((left, right) => compareStrings(left.id, right.id))
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
        .toSorted((left, right) => left.id.localeCompare(right.id))
    )
  );
}

export class AjvJsonSchemaReleaseInspector implements JsonSchemaReleaseInspector {
  async inspect(input: {
    readonly consumerRoot: string;
    readonly schemaPaths: readonly string[];
    readonly fixtures: readonly JsonSchemaFixture[];
    readonly signal?: AbortSignal;
  }): Promise<JsonSchemaInspection> {
    assertNotCancelled(input.signal);
    if (input.schemaPaths.length === 0 || input.schemaPaths.length > 1_000) {
      inputError("JSON_SCHEMA_PATHS_INVALID", "Contract must declare between one and 1000 schemas.");
    }
    if (new Set(input.schemaPaths).size !== input.schemaPaths.length) {
      inputError("JSON_SCHEMA_PATHS_INVALID", "Contract schema paths must be unique.");
    }
    assertFixtures(input.fixtures);
    const root = await realpath(input.consumerRoot).catch(() =>
      inputError("CONSUMER_ROOT_UNAVAILABLE", "Consumer root must be an existing accessible directory.")
    );
    if (!(await stat(root)).isDirectory()) {
      inputError("CONSUMER_ROOT_INVALID", "Consumer root must be a directory.");
    }
    const documents: SchemaDocument[] = [];
    for (const path of input.schemaPaths.toSorted(compareStrings)) {
      assertNotCancelled(input.signal);
      const value = record(await safeJsonFile(root, path), `schema ${path}`);
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
      assertLocalReferences(document.value, document.id, knownSchemaIds);
    }
    const ajv = compileSchemas(documents);
    const fixtureValues = new Map<string, unknown>();
    const fixtureResults: JsonSchemaFixtureResult[] = [];
    for (const fixture of input.fixtures.toSorted((left, right) => compareStrings(left.id, right.id))) {
      assertNotCancelled(input.signal);
      const value = await safeJsonFile(root, fixture.path);
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
      schemaIds: Object.freeze(schemaIds.toSorted(compareStrings)),
      fixtureResults: Object.freeze(fixtureResults.map((result) => Object.freeze(result)))
    } as const;
    if (!SHA256_DIGEST.test(output.schemaSetDigest) || !SHA256_DIGEST.test(output.fixtureCorpusDigest)) {
      inputError("JSON_SCHEMA_DIGEST_INVALID", "Internal JSON Schema digest generation failed.");
    }
    return Object.freeze(output);
  }
}

import type {
  JsonSchemaConsumerEvidence,
  JsonSchemaDigest,
  JsonSchemaFixture,
  JsonSchemaReleasePolicy,
  ReleasedJsonSchemaContractEvidence
} from "../../../application/model/json-schema-release.js";

import { CAPABILITY_CONFIG_SCHEMA_VERSION } from "../../../contract/config.js";

type JsonSchemaReleaseConfigSchemaVersion = typeof CAPABILITY_CONFIG_SCHEMA_VERSION;
type JsonSchemaReleaseSchemaId = "contract-json-schema-releases/v1";
type JsonSchemaReleasedBaselineSchemaId = "contract-json-schema-release-baseline/v1";

const SCHEMA_ID_BY_VERSION: Readonly<
  Record<JsonSchemaReleaseConfigSchemaVersion, JsonSchemaReleaseSchemaId>
> = Object.freeze({
  1: "contract-json-schema-releases/v1"
});

import { configurationInputError as inputError, assertConfigurationRepositoryPath } from "../../../application/configuration-input.js";

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError(`${field} must be a string.`);
  }
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number") {
    inputError(`${field} must be a number.`);
  }
  return value;
}

function configSchemaId(value: unknown): JsonSchemaReleaseSchemaId {
  if (value === CAPABILITY_CONFIG_SCHEMA_VERSION) {
    return SCHEMA_ID_BY_VERSION[value];
  }
  inputError(`schemaVersion must be ${CAPABILITY_CONFIG_SCHEMA_VERSION}.`);
}

function releasedBaselineSchemaId(value: unknown): JsonSchemaReleasedBaselineSchemaId {
  if (value === 1) {
    return "contract-json-schema-release-baseline/v1";
  }
  inputError("released baseline schemaVersion must be 1.");
}

function list(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    inputError(`${field} must be an array.`);
  }
  return value;
}

function digest(value: unknown, field: string): JsonSchemaDigest {
  return string(value, field) as JsonSchemaDigest;
}

function releasedBaselinePath(value: unknown): string {
  const repositoryPath = string(value, "releasedBaselinePath");
  assertConfigurationRepositoryPath(repositoryPath);
  if (!/\.(?:json|ya?ml)$/u.test(repositoryPath)) {
    inputError("releasedBaselinePath must name a JSON or YAML file.");
  }
  if (!repositoryPath.startsWith("architecture/contracts/")) {
    inputError("releasedBaselinePath must be inside the release-owned architecture/contracts directory.");
  }
  return repositoryPath;
}

function mapFixture(value: unknown, field: string): JsonSchemaFixture {
  const source = record(value, field);
  const expectation = string(source["expectation"], `${field}.expectation`);
  if (expectation !== "valid" && expectation !== "invalid") {
    inputError(`${field}.expectation is invalid.`);
  }
  return Object.freeze({
    id: string(source["id"], `${field}.id`),
    path: string(source["path"], `${field}.path`),
    schemaId: string(source["schemaId"], `${field}.schemaId`),
    expectation
  });
}

function mapConsumerEvidence(value: unknown, field: string): JsonSchemaConsumerEvidence {
  const source = record(value, field);
  const outcome = string(source["outcome"], `${field}.outcome`);
  if (outcome !== "passed" && outcome !== "failed") {
    inputError(`${field}.outcome is invalid.`);
  }
  return Object.freeze({
    consumerId: string(source["consumerId"], `${field}.consumerId`),
    consumerVersion: string(source["consumerVersion"], `${field}.consumerVersion`),
    contractId: string(source["contractId"], `${field}.contractId`),
    contractVersion: string(source["contractVersion"], `${field}.contractVersion`),
    schemaSetDigest: digest(source["schemaSetDigest"], `${field}.schemaSetDigest`),
    fixtureCorpusDigest: digest(source["fixtureCorpusDigest"], `${field}.fixtureCorpusDigest`),
    evidenceDigest: digest(source["evidenceDigest"], `${field}.evidenceDigest`),
    outcome
  });
}

export function mapReleased(
  value: unknown,
  field = "released baseline"
): ReleasedJsonSchemaContractEvidence {
  const source = record(value, field);
  return Object.freeze({
    schemaVersion: number(source["schemaVersion"], `${field}.schemaVersion`),
    contractId: string(source["contractId"], `${field}.contractId`),
    publicContractVersion: string(source["publicContractVersion"], `${field}.publicContractVersion`),
    schemaSetDigest: digest(source["schemaSetDigest"], `${field}.schemaSetDigest`),
    fixtureCorpusDigest: digest(source["fixtureCorpusDigest"], `${field}.fixtureCorpusDigest`),
    supportedConsumers: Object.freeze(
      list(source["supportedConsumers"], `${field}.supportedConsumers`).map((entry, index) =>
        mapConsumerEvidence(entry, `${field}.supportedConsumers[${index}]`)
      )
    )
  });
}

export function readConfigurationHeader(input: unknown) {
  const source = record(input, "JSON Schema release config");
  return { source, schemaId: configSchemaId(source["schemaVersion"]) };
}

export function readBaselineHeader(input: unknown) {
  const source = record(input, "JSON Schema released baseline");
  return { source, schemaId: releasedBaselineSchemaId(source["schemaVersion"]) };
}

export function parseReleasedBaselinePath(source: Record<string, unknown>): string {
  return releasedBaselinePath(source["releasedBaselinePath"]);
}

export function parseCapabilityPolicy(source: Record<string, unknown>, released: ReleasedJsonSchemaContractEvidence): JsonSchemaReleasePolicy {
  return Object.freeze({
    contractId: string(source["contractId"], "contractId"),
    publicContractVersion: string(source["publicContractVersion"], "publicContractVersion"),
    schemaPaths: Object.freeze(
      list(source["schemaPaths"], "schemaPaths").map((entry, index) =>
        string(entry, `schemaPaths[${index}]`)
      )
    ),
    fixtures: Object.freeze(
      list(source["fixtures"], "fixtures").map((entry, index) =>
        mapFixture(entry, `fixtures[${index}]`)
      )
    ),
    released,
    currentConsumerEvidence: Object.freeze(
      list(source["currentConsumerEvidence"], "currentConsumerEvidence").map((entry, index) =>
        mapConsumerEvidence(entry, `currentConsumerEvidence[${index}]`)
      )
    )
  });
}

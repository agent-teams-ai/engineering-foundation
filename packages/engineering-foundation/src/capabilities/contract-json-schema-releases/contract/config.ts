import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { assertNotCancelled, loadStrictYamlFile } from "../../../strict-yaml.js";
import type {
  JsonSchemaConsumerEvidence,
  JsonSchemaDigest,
  JsonSchemaFixture,
  JsonSchemaReleasePolicy,
  ReleasedJsonSchemaContractEvidence
} from "../application/model/json-schema-release.js";

export const CAPABILITY_ID = "contract.json-schema-releases" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

type JsonSchemaReleaseConfigSchemaVersion = typeof CAPABILITY_CONFIG_SCHEMA_VERSION;
type JsonSchemaReleaseSchemaId = "contract-json-schema-releases/v1";

const SCHEMA_ID_BY_VERSION: Readonly<
  Record<JsonSchemaReleaseConfigSchemaVersion, JsonSchemaReleaseSchemaId>
> = Object.freeze({
  1: "contract-json-schema-releases/v1"
});

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "JSON_SCHEMA_RELEASE_CONFIG_INVALID",
    message,
    phase: "json-schema-release-config",
    retryable: false
  });
}

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

function list(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    inputError(`${field} must be an array.`);
  }
  return value;
}

function digest(value: unknown, field: string): JsonSchemaDigest {
  return string(value, field) as JsonSchemaDigest;
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

function mapReleased(value: unknown): ReleasedJsonSchemaContractEvidence {
  const source = record(value, "released");
  return Object.freeze({
    schemaVersion: number(source["schemaVersion"], "released.schemaVersion"),
    contractId: string(source["contractId"], "released.contractId"),
    publicContractVersion: string(source["publicContractVersion"], "released.publicContractVersion"),
    schemaSetDigest: digest(source["schemaSetDigest"], "released.schemaSetDigest"),
    fixtureCorpusDigest: digest(source["fixtureCorpusDigest"], "released.fixtureCorpusDigest"),
    supportedConsumers: Object.freeze(
      list(source["supportedConsumers"], "released.supportedConsumers").map((entry, index) =>
        mapConsumerEvidence(entry, `released.supportedConsumers[${index}]`)
      )
    )
  });
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<JsonSchemaReleasePolicy> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "json-schema-release-config",
    signal
  );
  assertNotCancelled(signal);
  const source = record(input, "JSON Schema release config");
  await assertSchema(
    configSchemaId(source["schemaVersion"]),
    input,
    "json-schema-release-config"
  );
  assertNotCancelled(signal);
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
    released: mapReleased(source["released"]),
    currentConsumerEvidence: Object.freeze(
      list(source["currentConsumerEvidence"], "currentConsumerEvidence").map((entry, index) =>
        mapConsumerEvidence(entry, `currentConsumerEvidence[${index}]`)
      )
    )
  });
}

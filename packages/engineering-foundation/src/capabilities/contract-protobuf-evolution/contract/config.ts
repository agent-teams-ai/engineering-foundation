import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { assertNotCancelled, loadStrictYamlFile } from "../../../strict-yaml.js";
import type {
  BufBreakingEvidence,
  BufGeneratorVersionEvidence,
  CurrentProtobufContractEvidence,
  ProtobufEvolutionPolicy,
  ReleasedProtobufContractEvidence,
  Sha256Digest
} from "../application/model/protobuf-release-evidence.js";

export const CAPABILITY_ID = "contract.protobuf-evolution" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

type ProtobufEvolutionConfigSchemaVersion = typeof CAPABILITY_CONFIG_SCHEMA_VERSION;
type ProtobufEvolutionSchemaId = "contract-protobuf-evolution/v1";

const SCHEMA_ID_BY_VERSION: Readonly<
  Record<ProtobufEvolutionConfigSchemaVersion, ProtobufEvolutionSchemaId>
> = Object.freeze({
  1: "contract-protobuf-evolution/v1"
});

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "PROTOBUF_EVOLUTION_CONFIG_INVALID",
    message,
    phase: "protobuf-evolution-config",
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

function configSchemaId(value: unknown): ProtobufEvolutionSchemaId {
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

function optionalString(
  source: Record<string, unknown>,
  field: string
): string | undefined {
  const value = source[field];
  return value === undefined ? undefined : string(value, field);
}

function digest(value: unknown, field: string): Sha256Digest {
  return string(value, field) as Sha256Digest;
}

function mapGenerator(value: unknown, field: string): BufGeneratorVersionEvidence {
  const source = record(value, field);
  return Object.freeze({
    name: string(source["name"], `${field}.name`),
    version: string(source["version"], `${field}.version`)
  });
}

function mapGenerators(value: unknown, field: string): readonly BufGeneratorVersionEvidence[] {
  return Object.freeze(list(value, field).map((entry, index) => mapGenerator(entry, `${field}[${index}]`)));
}

function mapBreaking(value: unknown): BufBreakingEvidence {
  const source = record(value, "current.breaking");
  const status = string(source["status"], "current.breaking.status");
  if (status !== "compatible" && status !== "breaking" && status !== "not-run") {
    inputError("current.breaking.status is invalid.");
  }
  const approvalReference = optionalString(source, "approvalReference");
  const fingerprint = optionalString(source, "fingerprint");
  return Object.freeze({
    status,
    ...(approvalReference === undefined ? {} : { approvalReference }),
    ...(fingerprint === undefined ? {} : { fingerprint: fingerprint as Sha256Digest })
  });
}

function mapReleased(value: unknown): ReleasedProtobufContractEvidence {
  const source = record(value, "released");
  return Object.freeze({
    schemaVersion: number(source["schemaVersion"], "released.schemaVersion"),
    contractId: string(source["contractId"], "released.contractId"),
    publicContractVersion: string(source["publicContractVersion"], "released.publicContractVersion"),
    bufVersion: string(source["bufVersion"], "released.bufVersion"),
    bufConfigDigest: digest(source["bufConfigDigest"], "released.bufConfigDigest"),
    descriptorImageDigest: digest(source["descriptorImageDigest"], "released.descriptorImageDigest"),
    generatorVersions: mapGenerators(source["generatorVersions"], "released.generatorVersions"),
    generatedOutputDigest: digest(source["generatedOutputDigest"], "released.generatedOutputDigest")
  });
}

function mapCurrent(value: unknown): CurrentProtobufContractEvidence {
  const source = record(value, "current");
  const generationDrift = record(source["generationDrift"], "current.generationDrift");
  return Object.freeze({
    schemaVersion: number(source["schemaVersion"], "current.schemaVersion"),
    contractId: string(source["contractId"], "current.contractId"),
    publicContractVersion: string(source["publicContractVersion"], "current.publicContractVersion"),
    bufVersion: string(source["bufVersion"], "current.bufVersion"),
    bufConfigDigest: digest(source["bufConfigDigest"], "current.bufConfigDigest"),
    descriptorImageDigest: digest(source["descriptorImageDigest"], "current.descriptorImageDigest"),
    releasedDescriptorImageDigest: digest(
      source["releasedDescriptorImageDigest"],
      "current.releasedDescriptorImageDigest"
    ),
    generatorVersions: mapGenerators(source["generatorVersions"], "current.generatorVersions"),
    generationDrift: Object.freeze({
      expectedGeneratedOutputDigest: digest(
        generationDrift["expectedGeneratedOutputDigest"],
        "current.generationDrift.expectedGeneratedOutputDigest"
      ),
      observedGeneratedOutputDigest: digest(
        generationDrift["observedGeneratedOutputDigest"],
        "current.generationDrift.observedGeneratedOutputDigest"
      )
    }),
    breaking: mapBreaking(source["breaking"])
  });
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<ProtobufEvolutionPolicy> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "protobuf-evolution-config",
    signal
  );
  assertNotCancelled(signal);
  const source = record(input, "protobuf evolution config");
  await assertSchema(
    configSchemaId(source["schemaVersion"]),
    input,
    "protobuf-evolution-config"
  );
  assertNotCancelled(signal);
  return Object.freeze({
    released: mapReleased(source["released"]),
    current: mapCurrent(source["current"])
  });
}

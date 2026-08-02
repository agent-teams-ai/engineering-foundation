import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  assertNotCancelled,
  assertRepositoryRelativePath,
  loadStrictYamlFile
} from "../../../strict-yaml.js";
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
type ProtobufReleasedBaselineSchemaId = "contract-protobuf-evolution-baseline/v1";

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

function releasedBaselineSchemaId(value: unknown): ProtobufReleasedBaselineSchemaId {
  if (value === 1) {
    return "contract-protobuf-evolution-baseline/v1";
  }
  inputError("released baseline schemaVersion must be 1.");
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

function releasedBaselinePath(value: unknown): string {
  const repositoryPath = string(value, "releasedBaselinePath");
  assertRepositoryRelativePath(repositoryPath, "protobuf-evolution-config");
  if (!/\.(?:json|ya?ml)$/u.test(repositoryPath)) {
    inputError("releasedBaselinePath must name a JSON or YAML file.");
  }
  return repositoryPath;
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

function mapReleased(
  value: unknown,
  field = "released baseline"
): ReleasedProtobufContractEvidence {
  const source = record(value, field);
  return Object.freeze({
    schemaVersion: number(source["schemaVersion"], `${field}.schemaVersion`),
    contractId: string(source["contractId"], `${field}.contractId`),
    publicContractVersion: string(source["publicContractVersion"], `${field}.publicContractVersion`),
    bufVersion: string(source["bufVersion"], `${field}.bufVersion`),
    bufConfigDigest: digest(source["bufConfigDigest"], `${field}.bufConfigDigest`),
    descriptorImageDigest: digest(source["descriptorImageDigest"], `${field}.descriptorImageDigest`),
    generatorVersions: mapGenerators(source["generatorVersions"], `${field}.generatorVersions`),
    generatedOutputDigest: digest(source["generatedOutputDigest"], `${field}.generatedOutputDigest`)
  });
}

async function loadReleasedBaseline(
  consumerRoot: string,
  repositoryPath: string,
  signal: AbortSignal | undefined
): Promise<ReleasedProtobufContractEvidence> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    repositoryPath,
    "protobuf-evolution-baseline",
    signal
  );
  assertNotCancelled(signal);
  const source = record(input, "Protobuf released baseline");
  await assertSchema(
    releasedBaselineSchemaId(source["schemaVersion"]),
    input,
    "protobuf-evolution-baseline"
  );
  assertNotCancelled(signal);
  return mapReleased(source);
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
  const baselinePath = releasedBaselinePath(source["releasedBaselinePath"]);
  const released = await loadReleasedBaseline(consumerRoot, baselinePath, signal);
  return Object.freeze({
    released,
    current: mapCurrent(source["current"])
  });
}

import type { ProtobufEvolutionConfiguration, ReleasedProtobufContractEvidence } from "../../../application/model/protobuf-release-evidence.js";
import { assertConfigurationNotCancelled } from "../../../application/configuration-input.js";
import type { ProtobufSchemaAssertion } from "../../schema-validation.js";
import { readConfigurationHeader, readBaselineHeader, prepareConfiguration, parseCapabilityConfiguration, mapReleased } from "./parse-capability-config.js";

export interface ProtobufConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: ProtobufSchemaAssertion;
}

async function loadReleasedBaseline(
  dependencies: ProtobufConfigurationDependencies,
  consumerRoot: string,
  repositoryPath: string,
  signal: AbortSignal | undefined
): Promise<ReleasedProtobufContractEvidence> {
  const input = await dependencies.readYaml(consumerRoot, repositoryPath, "protobuf-evolution-baseline", signal);
  assertConfigurationNotCancelled(signal);
  const header = readBaselineHeader(input);
  await dependencies.assertSchema(header.schemaId, input, "protobuf-evolution-baseline");
  assertConfigurationNotCancelled(signal);
  return mapReleased(header.source);
}

export async function loadCapabilityConfig(
  dependencies: ProtobufConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<ProtobufEvolutionConfiguration> {
  const input = await dependencies.readYaml(consumerRoot, configPath, "protobuf-evolution-config", signal);
  assertConfigurationNotCancelled(signal);
  const header = readConfigurationHeader(input);
  await dependencies.assertSchema(header.schemaId, input, "protobuf-evolution-config");
  assertConfigurationNotCancelled(signal);
  const prepared = prepareConfiguration(header.source);
  const released = await loadReleasedBaseline(dependencies, consumerRoot, prepared.baselinePath, signal);
  return parseCapabilityConfiguration(prepared, released);
}

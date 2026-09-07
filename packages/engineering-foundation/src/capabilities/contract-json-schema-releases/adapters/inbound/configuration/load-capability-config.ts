import type { JsonSchemaReleasePolicy, ReleasedJsonSchemaContractEvidence } from "../../../application/model/json-schema-release.js";
import { assertConfigurationNotCancelled } from "../../../application/configuration-input.js";
import { readConfigurationHeader, readBaselineHeader, parseReleasedBaselinePath, parseCapabilityPolicy, mapReleased } from "./parse-capability-config.js";

export interface JsonSchemaConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "contract-json-schema-releases/v1" | "contract-json-schema-release-baseline/v1", input: unknown, phase: string) => Promise<void>;
}

async function loadReleasedBaseline(
  dependencies: JsonSchemaConfigurationDependencies,
  consumerRoot: string,
  repositoryPath: string,
  signal: AbortSignal | undefined
): Promise<ReleasedJsonSchemaContractEvidence> {
  const input = await dependencies.readYaml(consumerRoot, repositoryPath, "json-schema-release-baseline", signal);
  assertConfigurationNotCancelled(signal);
  const header = readBaselineHeader(input);
  await dependencies.assertSchema(header.schemaId, input, "json-schema-release-baseline");
  assertConfigurationNotCancelled(signal);
  return mapReleased(header.source);
}

export async function loadCapabilityConfig(
  dependencies: JsonSchemaConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<JsonSchemaReleasePolicy> {
  const input = await dependencies.readYaml(consumerRoot, configPath, "json-schema-release-config", signal);
  assertConfigurationNotCancelled(signal);
  const header = readConfigurationHeader(input);
  await dependencies.assertSchema(header.schemaId, input, "json-schema-release-config");
  assertConfigurationNotCancelled(signal);
  const baselinePath = parseReleasedBaselinePath(header.source);
  const released = await loadReleasedBaseline(dependencies, consumerRoot, baselinePath, signal);
  return parseCapabilityPolicy(header.source, released);
}

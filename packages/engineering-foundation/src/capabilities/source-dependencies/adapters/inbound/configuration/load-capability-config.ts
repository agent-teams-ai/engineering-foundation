import type { SourceArchitectureConfigSchemaVersion, SourceArchitecturePolicy } from "../../../application/model/source-workspace.js";
import { assertConfigurationNotCancelled } from "../../../application/configuration-input.js";
import { readSourceArchitectureHeader, parseSourceArchitecturePolicy } from "./parse-capability-config.js";

export interface SourceArchitectureConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string) => Promise<unknown>;
  readonly assertSchema: (schemaId: "architecture-source-dependencies/v1" | "architecture-source-dependencies/v2", input: unknown, phase: string) => Promise<void>;
}

const SOURCE_ARCHITECTURE_SCHEMA_IDS = Object.freeze({
  1: "architecture-source-dependencies/v1",
  2: "architecture-source-dependencies/v2"
} as const);

export async function loadCapabilityConfig(
  dependencies: SourceArchitectureConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal,
  observeSchemaVersion?: (version: SourceArchitectureConfigSchemaVersion) => void
): Promise<SourceArchitecturePolicy> {
  let input: unknown;
  try {
    // This contained read is bounded. Completing it once lets cancellation
    // reports retain the requested v1/v2 schema version without a second read.
    input = await dependencies.readYaml(consumerRoot, configPath, "source-architecture-config");
  } catch (error) {
    assertConfigurationNotCancelled(signal);
    throw error;
  }
  const header = readSourceArchitectureHeader(input);
  observeSchemaVersion?.(header.version);
  assertConfigurationNotCancelled(signal);
  await dependencies.assertSchema(SOURCE_ARCHITECTURE_SCHEMA_IDS[header.version], input, "source-architecture-config");
  return parseSourceArchitecturePolicy(header);
}

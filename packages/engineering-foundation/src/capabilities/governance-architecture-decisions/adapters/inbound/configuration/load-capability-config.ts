import type { ArchitectureDecisionPolicy } from "../../../application/model/architecture-decision.js";
import { parseCapabilityConfig } from "./parse-capability-config.js";

export interface ArchitectureDecisionConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "governance-architecture-decisions/v1", input: unknown, phase: string) => Promise<void>;
}

export async function loadCapabilityConfig(
  dependencies: ArchitectureDecisionConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<ArchitectureDecisionPolicy> {
  const input = await dependencies.readYaml(consumerRoot, configPath, "architecture-decision-governance-config", signal);
  await dependencies.assertSchema("governance-architecture-decisions/v1", input, "architecture-decision-governance-config");
  return parseCapabilityConfig(input);
}

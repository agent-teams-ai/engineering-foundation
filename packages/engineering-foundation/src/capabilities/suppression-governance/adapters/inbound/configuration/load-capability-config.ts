import type { SuppressionGovernancePolicy } from "../../../application/model/suppression-governance.js";
import { parseCapabilityConfig } from "./parse-capability-config.js";

export interface SuppressionConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "quality-suppression-governance/v1", input: unknown, phase: string) => Promise<void>;
}

export async function loadCapabilityConfig(
  dependencies: SuppressionConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<SuppressionGovernancePolicy> {
  const input = await dependencies.readYaml(
    consumerRoot,
    configPath,
    "suppression-governance-config",
    signal
  );
  await dependencies.assertSchema(
    "quality-suppression-governance/v1",
    input,
    "suppression-governance-config"
  );
  return parseCapabilityConfig(input);
}

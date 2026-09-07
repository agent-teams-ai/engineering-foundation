import type { QualityGatePolicy } from "../../../application/model/quality-gate.js";
import { parseQualityGatePolicy } from "./parse-quality-gate-policy.js";

export interface QualityGateConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "quality-gate-runner/v1", input: unknown, phase: string) => Promise<void>;
}

export async function loadQualityGatePolicy(
  dependencies: QualityGateConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<QualityGatePolicy> {
  const input = await dependencies.readYaml(
    consumerRoot,
    configPath,
    "quality-gate-runner-config",
    signal
  );
  await dependencies.assertSchema("quality-gate-runner/v1", input, "quality-gate-runner-config");
  return parseQualityGatePolicy(input);
}

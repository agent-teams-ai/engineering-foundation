import type { RepositorySecurityPolicy } from "../../../application/model/repository-security.js";
import { parseCapabilityConfig } from "./parse-capability-config.js";

export interface RepositorySecurityConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "repository-security-baseline/v1", input: unknown, phase: string) => Promise<void>;
}

export async function loadCapabilityConfig(
  dependencies: RepositorySecurityConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<RepositorySecurityPolicy> {
  const input = await dependencies.readYaml(
    consumerRoot,
    configPath,
    "repository-security-config",
    signal
  );
  await dependencies.assertSchema("repository-security-baseline/v1", input, "repository-security-config");
  return parseCapabilityConfig(input);
}

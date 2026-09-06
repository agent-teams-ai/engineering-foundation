import type { PublicApiCompatibilityPolicy } from "../../../application/model/public-api.js";
import type { PublicApiSchemaAssertion } from "../../schema-validation.js";
import { readConfigurationHeader, parseCapabilityConfig } from "./parse-capability-config.js";

export interface PublicApiConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: PublicApiSchemaAssertion;
}

export async function loadCapabilityConfig(
  dependencies: PublicApiConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<PublicApiCompatibilityPolicy> {
  const input = await dependencies.readYaml(consumerRoot, configPath, "public-api-compatibility-config", signal);
  const root = readConfigurationHeader(input);
  await dependencies.assertSchema("package-public-api-compatibility/v1", input, "public-api-compatibility-config");
  return parseCapabilityConfig(root);
}

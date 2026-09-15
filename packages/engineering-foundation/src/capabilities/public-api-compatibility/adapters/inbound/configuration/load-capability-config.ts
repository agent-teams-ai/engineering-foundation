import type { PublicApiCapabilityPolicy } from "../../../application/model/growth-configuration.js";
import type { PublicApiSchemaAssertion } from "../../schema-validation.js";
import { readPublicApiConfigurationHeader, mapPublicApiConfiguration } from "./parse-growth-config.js";
import { configurationInputError } from "../../../application/configuration-input.js";

export interface PublicApiConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: PublicApiSchemaAssertion;
}

export async function loadCapabilityConfig(
  dependencies: PublicApiConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<PublicApiCapabilityPolicy> {
  const input = await dependencies.readYaml(consumerRoot, configPath, "public-api-compatibility-config", signal);
  const root = readPublicApiConfigurationHeader(input);
  const schema = root["schemaVersion"] === 1 ? "package-public-api-compatibility/v1" : "package-public-api-compatibility/v2";
  await dependencies.assertSchema(schema, input, "public-api-compatibility-config");
  const policy = mapPublicApiConfiguration(root);
  if (policy.schemaVersion === 2 && policy.sdkGrowth.report.path === configPath) {
    configurationInputError("SDK report path must not replace the capability configuration.");
  }
  return policy;
}

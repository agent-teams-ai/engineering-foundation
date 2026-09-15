import type { PublicApiCapabilityPolicy } from "../../../application/model/growth-configuration.js";
import type { PublicApiSchemaAssertion } from "../../schema-validation.js";
import { readPublicApiConfigurationHeader, mapPublicApiConfiguration, assertGrowthReportDestination } from "./parse-growth-config.js";

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
  const policy = mapPublicApiConfiguration(root, configPath);
  if (policy.schemaVersion === 2) {
    const phase = "public-api-compatibility-config";
    const governance = await dependencies.readYaml(consumerRoot, policy.compatibility.governanceConfigPath!, phase, signal);
    await dependencies.assertSchema("governance-architecture-decisions/v1", governance, phase);
    // Read only the public schema's path projection. Governance still owns all
    // lifecycle and approval policy; none of these paths confer authority.
    const paths = governance as { adrRoots: readonly string[]; index: { path: string }; acceptedBaselinePath: string };
    assertGrowthReportDestination(policy.sdkGrowth.reportPath, [...paths.adrRoots, paths.index.path, paths.acceptedBaselinePath]);
  }
  return policy;
}

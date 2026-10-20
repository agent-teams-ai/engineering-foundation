import type { WorkspaceConfigurationSchemaAssertion } from "../../../application/configuration-input.js";
import { parseCapabilityConfig } from "./parse-capability-config.js";
import type { WorkspaceDependencyDeclarationsSettings } from "../../../application/model/workspace-dependency-settings.js";

export interface WorkspaceConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: WorkspaceConfigurationSchemaAssertion;
}

export async function loadCapabilityConfig(
  dependencies: WorkspaceConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<WorkspaceDependencyDeclarationsSettings> {
  const input = await dependencies.readYaml(
    consumerRoot,
    configPath,
    "workspace-dependency-declarations-config",
    signal
  );
  const version = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)["schemaVersion"]
    : undefined;
  await dependencies.assertSchema(
    version === 2 ? "workspace-dependency-declarations/v2" : "workspace-dependency-declarations/v1",
    input,
    "workspace-dependency-declarations-config"
  );
  return parseCapabilityConfig(input);
}

import { parseCapabilityConfig } from "./parse-capability-config.js";
import type { WorkspaceDependencyDeclarationsSettings } from "../../../application/model/workspace-dependency-settings.js";

export interface WorkspaceConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly readSchema: (schemaId: "workspace-dependency-declarations/v1") => Promise<string>;
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
  const schema = JSON.parse(
    await dependencies.readSchema("workspace-dependency-declarations/v1")
  ) as object;
  return parseCapabilityConfig(input, schema);
}

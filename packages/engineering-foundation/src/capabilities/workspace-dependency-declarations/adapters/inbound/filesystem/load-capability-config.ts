import { parseCapabilityConfig } from "./parse-capability-config.js";
import type { WorkspaceDependencyDeclarationsSettings } from "../../../application/model/workspace-dependency-settings.js";

export interface WorkspaceConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly readSchema: (schemaId: "workspace-dependency-declarations/v1" | "workspace-dependency-declarations/v2") => Promise<string>;
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
  const schema = JSON.parse(await dependencies.readSchema(
    version === 2 ? "workspace-dependency-declarations/v2" : "workspace-dependency-declarations/v1"
  )) as object;
  return parseCapabilityConfig(input, schema);
}

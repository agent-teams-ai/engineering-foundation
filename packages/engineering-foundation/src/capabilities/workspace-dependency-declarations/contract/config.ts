import { assertSchema } from "../../../schema-catalog.js";
import { loadStrictYamlFile } from "../../../strict-yaml.js";

export const CAPABILITY_ID = "workspace.dependency-declarations" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

export interface WorkspaceDependencyDeclarationsConfig {
  readonly schemaVersion: typeof CAPABILITY_CONFIG_SCHEMA_VERSION;
  readonly packageManager: {
    readonly kind: "pnpm";
    readonly workspaceManifest: "pnpm-workspace.yaml";
  };
  readonly policies: {
    readonly externalDependencies: "catalog";
    readonly catalogVersions: "exact";
    readonly internalDependencies: "workspace-protocol";
    readonly reservedScopes: readonly string[];
    readonly developmentOnlyPackages: readonly string[];
    readonly exactRegistryDevelopmentOnlyPackages: readonly string[];
  };
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<WorkspaceDependencyDeclarationsConfig> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "workspace-dependency-declarations-config",
    signal
  );
  await assertSchema(
    "workspace-dependency-declarations/v1",
    input,
    "workspace-dependency-declarations-config"
  );
  return input as WorkspaceDependencyDeclarationsConfig;
}

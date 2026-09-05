import { assertSchema } from "../../../schema-catalog.js";
import { loadStrictYamlFile } from "../../../features/configuration-input/node.js";
import type { WorkspaceDependencyPolicy } from "../application/model/workspace-dependency-policy.js";

export const CAPABILITY_ID = "workspace.dependency-declarations" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

export interface WorkspaceDependencyDeclarationsSettings {
  readonly packageManagerKind: "pnpm";
  readonly workspaceManifestPath: "pnpm-workspace.yaml";
  readonly policy: WorkspaceDependencyPolicy;
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<WorkspaceDependencyDeclarationsSettings> {
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

  const root = input as Record<string, unknown>;
  const packageManager = root["packageManager"] as Record<string, unknown>;
  const policies = root["policies"] as Record<string, unknown>;
  return Object.freeze({
    packageManagerKind: packageManager["kind"] as "pnpm",
    workspaceManifestPath: packageManager[
      "workspaceManifest"
    ] as "pnpm-workspace.yaml",
    policy: Object.freeze({
      reservedScopes: Object.freeze([...(policies["reservedScopes"] as string[])]),
      developmentOnlyPackages: Object.freeze([
        ...(policies["developmentOnlyPackages"] as string[])
      ]),
      exactRegistryDevelopmentOnlyPackages: Object.freeze([
        ...(policies["exactRegistryDevelopmentOnlyPackages"] as string[])
      ])
    })
  });
}

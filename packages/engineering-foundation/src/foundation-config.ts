import { assertSchema } from "./schema-catalog.js";
import { loadStrictYamlFile } from "./strict-yaml.js";

export const FOUNDATION_CONFIG_PATH = "foundation.config.yaml";
export const WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY =
  "workspace.dependency-declarations" as const;

export interface DeclaredCapability {
  readonly id: typeof WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY;
  readonly configPath: string;
}

export interface FoundationSettings {
  readonly projectId: string;
  readonly declaredCapabilities: readonly DeclaredCapability[];
}

export async function loadFoundationConfig(
  consumerRoot: string,
  signal?: AbortSignal
): Promise<FoundationSettings> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    FOUNDATION_CONFIG_PATH,
    "foundation-config",
    signal
  );
  await assertSchema("foundation-config/v1", input, "foundation-config");

  const root = input as Record<string, unknown>;
  const project = root["project"] as Record<string, unknown>;
  const capabilities = root["capabilities"] as Record<string, unknown>;
  const declaration = capabilities[
    WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY
  ] as Record<string, unknown> | undefined;

  return Object.freeze({
    projectId: project["id"] as string,
    declaredCapabilities:
      declaration === undefined
        ? []
        : [
            Object.freeze({
              id: WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY,
              configPath: declaration["configPath"] as string
            })
          ]
  });
}

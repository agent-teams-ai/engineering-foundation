import { assertSchema } from "./schema-catalog.js";
import { loadStrictYamlFile } from "./strict-yaml.js";

export const FOUNDATION_CONFIG_PATH = "foundation.config.yaml";
export const WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY =
  "workspace.dependency-declarations" as const;

export interface FoundationConfig {
  readonly schemaVersion: 1;
  readonly project: {
    readonly id: string;
  };
  readonly capabilities: {
    readonly "workspace.dependency-declarations"?: {
      readonly configPath: string;
    };
  };
}

export async function loadFoundationConfig(
  consumerRoot: string,
  signal?: AbortSignal
): Promise<FoundationConfig> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    FOUNDATION_CONFIG_PATH,
    "foundation-config",
    signal
  );
  await assertSchema("foundation-config/v1", input, "foundation-config");
  return input as FoundationConfig;
}

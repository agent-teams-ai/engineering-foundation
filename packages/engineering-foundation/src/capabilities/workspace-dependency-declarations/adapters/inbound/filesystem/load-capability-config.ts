import { readFoundationSchema } from "../../../../../schema-catalog.js";
import { loadStrictYamlFile } from "../../../../../strict-yaml.js";
import {
  parseCapabilityConfig,
  type WorkspaceDependencyDeclarationsSettings
} from "../../../contract/config.js";

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
  const schema = JSON.parse(
    await readFoundationSchema("workspace-dependency-declarations/v1")
  ) as object;
  return parseCapabilityConfig(input, schema);
}

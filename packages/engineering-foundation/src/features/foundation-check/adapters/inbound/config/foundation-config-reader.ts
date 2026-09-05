import type { FoundationConfigInput } from "../../../application/ports/foundation-config-input.js";
import { mapFoundationConfig } from "../../../application/map-foundation-config.js";
import type { FoundationConfigReader } from "../../../application/settings.js";

const FOUNDATION_CONFIG_PATH = "foundation.config.yaml";

export function createFoundationConfigReader(
  supportedCapabilityIds: ReadonlySet<string>,
  { assertSchema, loadStrictYamlFile }: FoundationConfigInput
): FoundationConfigReader {
  return async (consumerRoot, signal) => {
    const input = await loadStrictYamlFile(
      consumerRoot,
      FOUNDATION_CONFIG_PATH,
      "foundation-config",
      signal
    );
    await assertSchema("foundation-config/v1", input, "foundation-config");
    return mapFoundationConfig(input, supportedCapabilityIds);
  };
}

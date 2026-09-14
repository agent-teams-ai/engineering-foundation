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
    const version = typeof input === "object" && input !== null && "schemaVersion" in input ? input.schemaVersion : undefined;
    await assertSchema(version === 2 ? "foundation-config/v2" : "foundation-config/v1", input, "foundation-config");
    return mapFoundationConfig(input, supportedCapabilityIds);
  };
}

/** Captures the selected registry's capability IDs when module wiring is created. */
export function createRegisteredFoundationConfigReader(
  capabilities: Pick<ReadonlyMap<string, unknown>, "keys">,
  input: FoundationConfigInput
): FoundationConfigReader {
  return createFoundationConfigReader(new Set(capabilities.keys()), input);
}

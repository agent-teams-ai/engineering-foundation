import { invalidQualityInput, qualityRecord } from "./profile-input.js";
import type { QualityConfigurationReader } from "./consumer-observations.js";

export function createQualityConfigurationReader(
  assertSchema: (id: "quality-source-coverage/v5", value: unknown, phase: string) => Promise<void>,
  createReader: QualityConfigurationReader["createReader"],
): QualityConfigurationReader {
  return {
    createReader,
    assertProfile: (value) => assertSchema("quality-source-coverage/v5", value, "quality-profile"),
  };
}

/** Retain only admitted numeric version provenance, even for an unsupported old profile. */
export function admitQualityProfileVersion(
  value: unknown,
  observe?: (version: number) => void,
): void {
  const version = qualityRecord(value)["schemaVersion"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    invalidQualityInput("Quality profile schemaVersion must be a positive safe integer.");
  }
  observe?.(version);
  if (version !== 5) {
    invalidQualityInput(
      "Quality coverage requires schemaVersion 5. Migrate featureProfilePath to topologyPath and compiler projects to toolchainConfigPath; see the v5 migration guide, or retain the previous Foundation major.",
    );
  }
}

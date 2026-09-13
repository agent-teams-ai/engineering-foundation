import type { QualityConfigurationReader } from "./consumer-observations.js";

export function createQualityConfigurationReader(
  read: QualityConfigurationReader["read"],
  assertSchema: (id: "quality-source-coverage/v1", value: unknown, phase: string) => Promise<void>
): QualityConfigurationReader {
  return { read, assertProfile: (value) => assertSchema("quality-source-coverage/v1", value, "quality-profile") };
}

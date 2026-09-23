import type { QualityConfigurationReader } from "./consumer-observations.js";

export function createQualityConfigurationReader(
  read: QualityConfigurationReader["read"],
  assertSchema: (id: "quality-source-coverage/v1" | "quality-source-coverage/v2", value: unknown, phase: string) => Promise<void>
): QualityConfigurationReader {
  return {
    read,
    assertProfile: (value) => {
      const version = typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)["schemaVersion"] : undefined;
      return assertSchema(version === 2 ? "quality-source-coverage/v2" : "quality-source-coverage/v1", value, "quality-profile");
    }
  };
}

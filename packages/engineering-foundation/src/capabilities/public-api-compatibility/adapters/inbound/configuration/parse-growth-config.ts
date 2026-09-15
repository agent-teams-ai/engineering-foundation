import { configurationInputError, assertConfigurationRepositoryPath } from "../../../application/configuration-input.js";
import type { PublicApiCapabilityPolicy, SdkGrowthCapabilityPolicy } from "../../../application/model/growth-configuration.js";
import { normalizeGrowthInvocation } from "../../../application/policies/normalize-growth-observation.js";
import { parseCapabilityConfig } from "./parse-capability-config.js";

export function readPublicApiConfigurationHeader(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    configurationInputError("public API compatibility config must be an object.");
  }
  const root = input as Record<string, unknown>;
  if (root["schemaVersion"] !== 1 && root["schemaVersion"] !== 2) {
    configurationInputError("schemaVersion must be 1 or 2.");
  }
  return root;
}

/** Invoked only after the selected closed JSON schema validates the raw data. */
export function mapPublicApiConfiguration(root: Record<string, unknown>): PublicApiCapabilityPolicy {
  if (root["schemaVersion"] === 1) { return parseCapabilityConfig(root); }
  const { sdkGrowth: rawGrowth, ...legacy } = root;
  const compatibility = parseCapabilityConfig({ ...legacy, schemaVersion: 1 });
  const growth = structuredClone(rawGrowth) as SdkGrowthCapabilityPolicy["sdkGrowth"];
  const paths = [growth.workspaceManifestPath, growth.context.trustedBasePath, growth.context.decisionsPath,
    ...growth.context.released.map((entry) => entry.kind === "released" ? entry.observationPath : entry.trustedHistoryPath)];
  for (const path of [...paths, growth.report.path]) { assertConfigurationRepositoryPath(path); }
  if (paths.includes(growth.report.path) || compatibility.packages.some((pkg) =>
    [pkg.manifestPath, pkg.tsconfigPath, pkg.releasedBaselinePath, ...pkg.entrypoints.map((entry) => entry.declarationEntryPoint)].includes(growth.report.path))) {
    configurationInputError("SDK report path must not replace a configuration, observation or package input.");
  }
  const names = growth.context.released.map((entry) => entry.packageName);
  if (new Set(names).size !== names.length) { configurationInputError("SDK released package identities must be unique."); }
  return Object.freeze({ schemaVersion: 2, compatibility, sdkGrowth: Object.freeze({ ...growth,
    invocation: normalizeGrowthInvocation(growth.invocation) }) });
}

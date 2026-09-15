import { configurationInputError, assertConfigurationRepositoryPath } from "../../../application/configuration-input.js";
import type { PublicApiCapabilityPolicy, SdkGrowthCapabilityPolicy } from "../../../application/model/growth-configuration.js";
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
export function mapPublicApiConfiguration(root: Record<string, unknown>, configPath?: string): PublicApiCapabilityPolicy {
  if (root["schemaVersion"] === 1) { return parseCapabilityConfig(root); }
  const { sdkGrowth: rawGrowth, ...legacy } = root;
  const compatibility = parseCapabilityConfig({ ...legacy, schemaVersion: 1 });
  const growth = structuredClone(rawGrowth) as SdkGrowthCapabilityPolicy["sdkGrowth"];
  const paths = [growth.comparison.trustedBasePath, growth.decisionsPath,
    ...growth.comparison.released.map((entry) => entry.kind === "released" ? entry.observationPath : entry.trustedHistoryPath)];
  for (const path of [...paths, growth.reportPath, compatibility.changesetDirectory, compatibility.governanceConfigPath!,
    ...compatibility.packages.flatMap((pkg) => [pkg.packageRoot, pkg.manifestPath, pkg.tsconfigPath, ...pkg.entrypoints.map((entry) => entry.declarationEntryPoint)])]) {
    assertConfigurationRepositoryPath(path);
    if (path.length > 300 || path.trim() !== path || path.trim().length === 0 || /^[a-z]:/iu.test(path) || /[\0*?{}[\]]/u.test(path)) {
      configurationInputError("SDK paths must be normalized nonempty repository-relative regular-file paths.");
    }
  }
  assertGrowthReportDestination(growth.reportPath, [
    ...paths, ...(configPath === undefined ? [] : [configPath]),
    "package.json", "tsconfig.json", "tsconfig.base.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "package-lock.json",
    "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb",
    "architecture", ".git", ".github", "node_modules", ".npmrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs",
    "foundation.config.yaml", "foundation.config.json", "src", "scripts", "tests", compatibility.changesetDirectory, compatibility.governanceConfigPath,
    compatibility.acceptedDecisionBaselinePath,
    ...compatibility.packages.flatMap((pkg) => [pkg.packageRoot, pkg.manifestPath, pkg.tsconfigPath,
      pkg.releasedBaselinePath, ...pkg.entrypoints.map((entry) => entry.declarationEntryPoint)])
  ].filter((path): path is string => path !== undefined));
  const names = growth.comparison.released.map((entry) => entry.packageName);
  if (new Set(names).size !== names.length) { configurationInputError("SDK released package identities must be unique."); }
  return Object.freeze({ schemaVersion: 2, compatibility, sdkGrowth: Object.freeze({ ...growth, comparison: Object.freeze({ ...growth.comparison,
    released: Object.freeze([...growth.comparison.released].toSorted((a, b) => a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0)) }) }) });
}

/** Protect both descendants and ancestors: a destination cannot replace a
 * directory that owns an input, even when the final file does not exist yet. */
export function assertGrowthReportDestination(destination: string, protectedPaths: readonly string[]): void {
  if (protectedPaths.some((path) => destination === path || destination.startsWith(`${path}/`) || path.startsWith(`${destination}/`))) {
    configurationInputError("SDK report path overlaps a protected input, governance, baseline, lockfile or package path.");
  }
}

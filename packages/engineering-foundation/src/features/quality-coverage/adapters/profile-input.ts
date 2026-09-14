import { CapabilityInputError, type QualityCoverageProfile, type QualityTopology } from "../api.js";

export function invalidQualityInput(message: string): never {
  throw new CapabilityInputError({ code: "QUALITY_PROFILE_INVALID", message, phase: "quality-profile", retryable: false });
}

export function qualityRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { invalidQualityInput("Expected a data object in the quality profile inputs."); }
  return Object.fromEntries(Object.entries(value));
}

export function qualityString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) { invalidQualityInput("Expected a bounded nonempty string in the quality profile inputs."); }
  return value;
}

export function qualityStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 10_000) { invalidQualityInput("Expected a bounded list in the quality profile inputs."); }
  return value.map(qualityString);
}

export function mapQualityProfile(value: unknown): QualityCoverageProfile {
  const input = qualityRecord(value);
  const scripts = qualityRecord(input["scripts"]);
  const compilerProjects = qualityStrings(input["compilerProjects"]);
  if (compilerProjects.length === 0 || new Set(compilerProjects).size !== compilerProjects.length) {
    invalidQualityInput("Quality coverage requires nonempty unique compiler project paths.");
  }
  return {
    sourcePolicyPath: qualityString(input["sourcePolicyPath"]),
    suppressionPolicyPath: qualityString(input["suppressionPolicyPath"]),
    featureProfilePath: qualityString(input["featureProfilePath"]),
    lintConfigPath: qualityString(input["lintConfigPath"]),
    compilerProjects,
    ...(input["nativeChecks"] === undefined ? {} : { nativeChecks: nativeChecks(input["nativeChecks"]) }),
    scripts: { fast: qualityString(scripts["fast"]), full: qualityString(scripts["full"]), scope: qualityString(scripts["scope"]), typed: qualityString(scripts["typed"]) }
  };
}

function boundedModules(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5000) {
    invalidQualityInput("FMS profile requires a nonempty bounded module mapping.");
  }
  return value.map(qualityRecord);
}

function nestedTopology(input: Record<string, unknown>): QualityTopology {
  const scope = qualityRecord(input["scope"]);
  const adoption = qualityRecord(input["adoption"]);
  const layout = qualityRecord(adoption["abstractLayout"]);
  const modules = boundedModules(scope["productionModules"]);
  const layouts = boundedModules(layout["modules"]);
  for (const entry of layouts) {
    if (!modules.some((module) => module["moduleRoot"] === entry["moduleRoot"] && module["sourceRoot"] === entry["sourceRoot"])) {
      invalidQualityInput("An abstract layout must map an existing production module and its source root.");
    }
  }
  const applications = qualityStrings(adoption["applicationRoots"]);
  // Adoption names application packages; scope owns their exact production sources.
  const applicationRoots = applications.length === 0 ? [] : qualityStrings(scope["productionRoots"])
    .filter((sourceRoot) => applications.some((root) => sourceRoot === root || sourceRoot.startsWith(`${root}/`)));
  for (const root of applications) {
    if (!applicationRoots.some((sourceRoot) => sourceRoot === root || sourceRoot.startsWith(`${root}/`))) {
      invalidQualityInput("An application must map an existing production source root.");
    }
  }
  return {
    productionRoots: qualityStrings(scope["workspaceContainers"]),
    applicationRoots: applications,
    productionSourceRoots: [...new Set([
      ...modules.map((module) => qualityString(module["sourceRoot"])),
      ...applicationRoots
    ])],
    excludedRoots: qualityStrings(adoption["excludedRoots"]),
    modules: modules.map((module) => ({
      root: qualityString(module["moduleRoot"]), sourceRoot: qualityString(module["sourceRoot"]),
      testRoots: layouts.filter((entry) => entry["moduleRoot"] === module["moduleRoot"]).map((entry) => qualityString(entry["testRoot"]))
    }))
  };
}

/** Normalize qualified flat and nested FMS forms; adoption status does not filter production. */
export function mapQualityTopology(value: unknown, sourcePolicyPath: string): QualityTopology {
  const input = qualityRecord(value);
  const nested = input["authority"] !== undefined;
  const standard = qualityRecord(nested ? input["authority"] : input["standard"]);
  if (input["schemaVersion"] !== 1 || standard["id"] !== "agent-teams.feature-module-standard" || standard["version"] !== "v1") {
    invalidQualityInput("Quality coverage requires an FMS v1 production mapping.");
  }
  if (nested) { return nestedTopology(input); }
  const topology = qualityRecord(input["topology"]);
  if (topology["sourcePolicy"] !== sourcePolicyPath) {
    invalidQualityInput("Quality coverage requires the accepted FMS source-policy mapping.");
  }
  return {
    productionRoots: qualityStrings(input["productionRoots"]),
    applicationRoots: qualityStrings(input["applicationRoots"]),
    excludedRoots: qualityStrings(input["excludedRoots"]),
    toolingFiles: boundedModules(input["modules"]).flatMap((module) => generatorPaths(module["generatedRoots"])),
    modules: boundedModules(input["modules"]).map((module) => ({
      root: qualityString(module["root"]), sourceRoot: qualityString(module["sourceRoot"]), testRoots: qualityStrings(module["testRoots"])
    }))
  };
}

function generatorPaths(value: unknown): readonly string[] {
  if (value === undefined) { return []; }
  if (!Array.isArray(value) || value.length > 5000) { invalidQualityInput("Expected bounded generated provenance records."); }
  return value.map((entry: unknown) => qualityString(qualityRecord(entry)["generator"]));
}

function nativeChecks(value: unknown): NonNullable<QualityCoverageProfile["nativeChecks"]> {
  if (!Array.isArray(value) || value.length > 1000) { invalidQualityInput("Expected bounded native gate mappings."); }
  return value.map((entry: unknown) => {
    const item = qualityRecord(entry);
    return { boundaryId: qualityString(item["boundaryId"]), script: qualityString(item["script"]) };
  });
}

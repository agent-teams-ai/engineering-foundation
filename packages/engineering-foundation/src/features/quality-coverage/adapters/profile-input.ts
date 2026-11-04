import type { QualityCoverageProfile } from "../api.js";
import {
  invalidQualityInput,
  qualityRecord,
  qualityString,
  qualityStrings,
} from "./quality-input-values.js";
export {
  invalidQualityInput,
  qualityRecord,
  qualityString,
  qualityScriptCommand,
  qualityStrings,
} from "./quality-input-values.js";

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
    schemaVersion: 5,
    budgetMs: qualityBudget(input["budgetMs"]),
    topologyPath: qualityString(input["topologyPath"]),
    toolchainConfigPath: qualityString(input["toolchainConfigPath"]),
    lintConfigPath: qualityString(input["lintConfigPath"]),
    ...(input["bridgeAdmissionsPath"] === undefined
      ? {}
      : { bridgeAdmissionsPath: qualityString(input["bridgeAdmissionsPath"]) }),
    compilerProjects,
    ...(input["nativeChecks"] === undefined
      ? {}
      : { nativeChecks: nativeChecks(input["nativeChecks"]) }),
    ...(input["assets"] === undefined ? {} : { assets: assets(input["assets"]) }),
    scripts: {
      fast: qualityString(scripts["fast"]),
      full: qualityString(scripts["full"]),
      scope: qualityString(scripts["scope"]),
      typed: qualityString(scripts["typed"]),
    },
  };
}

function assets(value: unknown): NonNullable<QualityCoverageProfile["assets"]> {
  if (!Array.isArray(value) || value.length > 1000) {
    invalidQualityInput("Expected bounded exact asset mappings.");
  }
  const paths = new Set<string>();
  return value.map((entry: unknown) => {
    const item = qualityRecord(entry);
    const path = qualityString(item["path"]);
    const kind = item["kind"];
    if (
      (kind !== "protobuf" && kind !== "sql-migration") ||
      !path.endsWith(kind === "protobuf" ? ".proto" : ".sql") ||
      paths.has(path)
    ) {
      invalidQualityInput(
        "Asset mappings require one exact path with its fixed protobuf or sql-migration extension.",
      );
    }
    paths.add(path);
    return {
      path,
      kind,
      boundaryId: qualityString(item["boundaryId"]),
      script: qualityString(item["script"]),
    };
  });
}

function nativeChecks(value: unknown): NonNullable<QualityCoverageProfile["nativeChecks"]> {
  if (!Array.isArray(value) || value.length > 1000) {
    invalidQualityInput("Expected bounded native gate mappings.");
  }
  return value.map((entry: unknown) => {
    const item = qualityRecord(entry);
    return { boundaryId: qualityString(item["boundaryId"]), script: qualityString(item["script"]) };
  });
}

function qualityBudget(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1000 ||
    value > 1800000
  ) {
    invalidQualityInput("Quality budgetMs must be an integer between 1000 and 1800000.");
  }
  return value;
}

export { mapQualityTopology } from "./topology-input.js";

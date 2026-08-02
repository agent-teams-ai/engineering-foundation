import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  assertRepositoryRelativePath,
  loadStrictYamlFile
} from "../../../strict-yaml.js";
import type {
  ApprovedBreakingChange,
  PublicApiCompatibilityConfigSchemaVersion,
  PublicApiCompatibilityPolicy,
  PublicApiEntrypointPolicy,
  PublicApiNonTypeExportKind,
  PublicApiNonTypeExportPolicy,
  PublicApiPackagePolicy
} from "../application/model/public-api.js";
import {
  compareCanonicalReferences,
  publicApiBaselineAnchorPath
} from "../application/model/public-api.js";

export const CAPABILITY_ID = "package.public-api-compatibility" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 2 as const;
const ACCEPTED_DECISION_BASELINE_PATH =
  "architecture/decisions/accepted-decisions.json" as const;

type PublicApiCompatibilitySchemaId =
  | "package-public-api-compatibility/v1"
  | "package-public-api-compatibility/v2";

const SCHEMA_ID_BY_VERSION: Readonly<
  Record<PublicApiCompatibilityConfigSchemaVersion, PublicApiCompatibilitySchemaId>
> = Object.freeze({
  1: "package-public-api-compatibility/v1",
  2: "package-public-api-compatibility/v2"
});

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "PUBLIC_API_COMPATIBILITY_CONFIG_INVALID",
    message,
    phase: "public-api-compatibility-config",
    retryable: false
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError(`${field} must be a string.`);
  }
  return value;
}

function path(value: unknown, field: string): string {
  const repositoryPath = string(value, field);
  assertRepositoryRelativePath(repositoryPath, "public-api-compatibility-config");
  return repositoryPath;
}

function schemaVersion(value: unknown): PublicApiCompatibilityConfigSchemaVersion {
  if (value === 1 || value === 2) {
    return value;
  }
  inputError("schemaVersion must be either 1 or 2.");
}

function normalizedExportPath(value: unknown, field: string): string {
  const output = string(value, field);
  if (output === ".") {
    return output;
  }
  const segments = output.startsWith("./") ? output.slice(2).split("/") : [];
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." || segment.includes("\\")
    )
  ) {
    inputError(`${field} must be . or a normalized package export subpath.`);
  }
  return output;
}

function typedExportPath(value: unknown, field: string): string {
  const output = normalizedExportPath(value, field);
  if (output.includes("*")) {
    inputError(`${field} cannot be a wildcard typed export path.`);
  }
  return output;
}

function nonTypeExportKind(value: unknown, field: string): PublicApiNonTypeExportKind {
  if (value === "data" || value === "runtime" || value === "wildcard") {
    return value;
  }
  inputError(`${field} must be data, runtime, or wildcard.`);
}

function acceptedDecisionBaselinePath(value: unknown): string {
  const repositoryPath = path(value, "acceptedDecisionBaselinePath");
  if (repositoryPath !== ACCEPTED_DECISION_BASELINE_PATH) {
    inputError(
      `acceptedDecisionBaselinePath must use the stable ${ACCEPTED_DECISION_BASELINE_PATH} anchor.`
    );
  }
  return repositoryPath;
}

function pathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function mapApproval(value: unknown, packageIndex: number, index: number): ApprovedBreakingChange {
  const field = `packages[${packageIndex}].approvedBreakingChanges[${index}]`;
  const approval = record(value, field);
  return Object.freeze({
    fingerprint: string(approval["fingerprint"], `${field}.fingerprint`),
    decisionPath: path(approval["decisionPath"], `${field}.decisionPath`)
  });
}

function mapEntrypoints(
  value: unknown,
  packageIndex: number
): readonly PublicApiEntrypointPolicy[] {
  const field = `packages[${packageIndex}].entrypoints`;
  if (!Array.isArray(value)) {
    inputError(`${field} must be an array.`);
  }
  return Object.freeze(
    value
      .map((entrypoint, index) => {
        const entrypointField = `${field}[${index}]`;
        const input = record(entrypoint, entrypointField);
        return Object.freeze({
          exportPath: typedExportPath(input["exportPath"], `${entrypointField}.exportPath`),
          declarationEntryPoint: path(
            input["declarationEntryPoint"],
            `${entrypointField}.declarationEntryPoint`
          )
        });
      })
      .toSorted((left, right) =>
        compareCanonicalReferences(left.exportPath, right.exportPath)
      )
  );
}

function mapNonTypeExports(
  value: unknown,
  packageIndex: number
): readonly PublicApiNonTypeExportPolicy[] {
  const field = `packages[${packageIndex}].nonTypeExports`;
  if (!Array.isArray(value)) {
    inputError(`${field} must be an array.`);
  }
  return Object.freeze(
    value
      .map((entrypoint, index) => {
        const entrypointField = `${field}[${index}]`;
        const input = record(entrypoint, entrypointField);
        return Object.freeze({
          exportPath: normalizedExportPath(input["exportPath"], `${entrypointField}.exportPath`),
          kind: nonTypeExportKind(input["kind"], `${entrypointField}.kind`)
        });
      })
      .toSorted((left, right) =>
        compareCanonicalReferences(left.exportPath, right.exportPath)
      )
  );
}

function mapPackage(
  value: unknown,
  index: number,
  version: PublicApiCompatibilityConfigSchemaVersion
): PublicApiPackagePolicy {
  const field = `packages[${index}]`;
  const input = record(value, field);
  const packageRoot = path(input["packageRoot"], `${field}.packageRoot`);
  const manifestPath = path(input["manifestPath"], `${field}.manifestPath`);
  const tsconfigPath = path(input["tsconfigPath"], `${field}.tsconfigPath`);
  const approvals = input["approvedBreakingChanges"];
  if (!Array.isArray(approvals)) {
    inputError(`${field}.approvedBreakingChanges must be an array.`);
  }
  const entrypoints =
    version === 1
      ? undefined
      : mapEntrypoints(input["entrypoints"], index);
  const nonTypeExports =
    version === 1
      ? undefined
      : mapNonTypeExports(input["nonTypeExports"], index);
  const declarationEntryPoint =
    version === 1
      ? path(input["declarationEntryPoint"], `${field}.declarationEntryPoint`)
      : undefined;
  const paths = [manifestPath, tsconfigPath];
  if (declarationEntryPoint !== undefined) {
    paths.push(declarationEntryPoint);
  }
  if (entrypoints !== undefined) {
    paths.push(...entrypoints.map((entrypoint) => entrypoint.declarationEntryPoint));
  }
  for (const repositoryPath of paths) {
    if (!pathInside(repositoryPath, packageRoot)) {
      inputError(`${repositoryPath} must be inside package root ${packageRoot}.`);
    }
  }
  const common = {
    packageName: string(input["packageName"], `${field}.packageName`),
    packageRoot,
    manifestPath,
    tsconfigPath,
    releasedBaselinePath: path(
      input["releasedBaselinePath"],
      `${field}.releasedBaselinePath`
    ),
    approvedBreakingChanges: Object.freeze(
      approvals.map((approval, approvalIndex) =>
        mapApproval(approval, index, approvalIndex)
      )
    )
  };
  if (declarationEntryPoint !== undefined) {
    return Object.freeze({ ...common, declarationEntryPoint });
  }
  if (entrypoints === undefined) {
    inputError(`${field}.entrypoints must be present for schemaVersion 2.`);
  }
  if (nonTypeExports === undefined) {
    inputError(`${field}.nonTypeExports must be present for schemaVersion 2.`);
  }
  return Object.freeze({ ...common, entrypoints, nonTypeExports });
}

function validatePolicy(policy: PublicApiCompatibilityPolicy): void {
  const names = new Set<string>();
  const baselines = new Set<string>();
  for (const packagePolicy of policy.packages) {
    if (names.has(packagePolicy.packageName)) {
      inputError(`Package identity is duplicated: ${packagePolicy.packageName}.`);
    }
    names.add(packagePolicy.packageName);
    const expectedAnchor = publicApiBaselineAnchorPath(packagePolicy.packageName);
    if (packagePolicy.releasedBaselinePath !== expectedAnchor) {
      inputError(
        `Released baseline path must use the stable package anchor: ${expectedAnchor}.`
      );
    }
    if (baselines.has(packagePolicy.releasedBaselinePath)) {
      inputError(`Released baseline path is duplicated: ${packagePolicy.releasedBaselinePath}.`);
    }
    baselines.add(packagePolicy.releasedBaselinePath);
    const fingerprints = new Set<string>();
    for (const approval of packagePolicy.approvedBreakingChanges) {
      if (fingerprints.has(approval.fingerprint)) {
        inputError(`Breaking-change fingerprint is duplicated: ${approval.fingerprint}.`);
      }
      fingerprints.add(approval.fingerprint);
    }
    if ("entrypoints" in packagePolicy) {
      const exportPaths = new Set<string>();
      for (const entrypoint of packagePolicy.entrypoints) {
        if (exportPaths.has(entrypoint.exportPath)) {
          inputError(
            `Package export path is duplicated: ${packagePolicy.packageName}:${entrypoint.exportPath}.`
          );
        }
        exportPaths.add(entrypoint.exportPath);
      }
      for (const nonTypeExport of packagePolicy.nonTypeExports) {
        if (exportPaths.has(nonTypeExport.exportPath)) {
          inputError(
            `Package export path is declared as both typed and non-type: ${packagePolicy.packageName}:${nonTypeExport.exportPath}.`
          );
        }
        exportPaths.add(nonTypeExport.exportPath);
      }
    }
  }
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<PublicApiCompatibilityPolicy> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "public-api-compatibility-config",
    signal
  );
  const root = record(input, "public API compatibility config");
  const version = schemaVersion(root["schemaVersion"]);
  await assertSchema(
    SCHEMA_ID_BY_VERSION[version],
    input,
    "public-api-compatibility-config"
  );
  const packages = root["packages"];
  if (!Array.isArray(packages)) {
    inputError("packages must be an array.");
  }
  const decisionBaselineValue = root["acceptedDecisionBaselinePath"];
  const decisionBaselinePath =
    decisionBaselineValue === undefined
      ? undefined
      : acceptedDecisionBaselinePath(decisionBaselineValue);
  const common = {
    changesetDirectory: path(root["changesetDirectory"], "changesetDirectory"),
    packages: Object.freeze(
      packages.map((packagePolicy, index) => mapPackage(packagePolicy, index, version))
    )
  };
  const policy: PublicApiCompatibilityPolicy =
    version === 1
      ? Object.freeze({
          schemaVersion: 1,
          ...(decisionBaselinePath === undefined
            ? {}
            : { acceptedDecisionBaselinePath: decisionBaselinePath }),
          changesetDirectory: common.changesetDirectory,
          packages: Object.freeze(
            common.packages.map((packagePolicy) => {
              if ("entrypoints" in packagePolicy) {
                inputError("schemaVersion 1 cannot declare entrypoints.");
              }
              return packagePolicy;
            })
          )
        })
      : Object.freeze({
          schemaVersion: 2,
          acceptedDecisionBaselinePath:
            decisionBaselinePath ??
            inputError("schemaVersion 2 requires acceptedDecisionBaselinePath."),
          changesetDirectory: common.changesetDirectory,
          packages: Object.freeze(
            common.packages.map((packagePolicy) => {
              if (!("entrypoints" in packagePolicy)) {
                inputError("schemaVersion 2 requires entrypoints.");
              }
              return packagePolicy;
            })
          )
        });
  if (
    policy.packages.some(
      (packagePolicy) => packagePolicy.approvedBreakingChanges.length > 0
    ) &&
    policy.acceptedDecisionBaselinePath === undefined
  ) {
    inputError("acceptedDecisionBaselinePath is required when breaking approvals are declared.");
  }
  validatePolicy(policy);
  return policy;
}

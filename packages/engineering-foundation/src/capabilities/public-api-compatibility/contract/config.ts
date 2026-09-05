import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
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
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;
const ACCEPTED_DECISION_BASELINE_PATH =
  "architecture/decisions/accepted-decisions.json" as const;
const ADR_ID = /^ADR-\d{4}$/u;

const PUBLIC_API_COMPATIBILITY_SCHEMA_ID =
  "package-public-api-compatibility/v1" as const;

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
  if (value === 1) {
    return 1;
  }
  inputError("schemaVersion must be 1.");
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

function governanceConfigPath(value: unknown): string {
  const repositoryPath = path(value, "governanceConfigPath");
  if (!/\.ya?ml$/u.test(repositoryPath)) {
    inputError("governanceConfigPath must name a YAML architecture-governance configuration file.");
  }
  return repositoryPath;
}

function pathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function mapApproval(
  value: unknown,
  packageIndex: number,
  index: number
): ApprovedBreakingChange {
  const field = `packages[${packageIndex}].approvedBreakingChanges[${index}]`;
  const approval = record(value, field);
  const decisionId = string(approval["decisionId"], `${field}.decisionId`);
  if (!ADR_ID.test(decisionId)) {
    inputError(`${field}.decisionId must match ADR-NNNN.`);
  }
  return Object.freeze({
    fingerprint: string(approval["fingerprint"], `${field}.fingerprint`),
    decisionId: decisionId as `ADR-${string}`
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
  index: number
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
  const entrypoints = mapEntrypoints(input["entrypoints"], index);
  const nonTypeExports = mapNonTypeExports(input["nonTypeExports"], index);
  const paths = [manifestPath, tsconfigPath];
  paths.push(...entrypoints.map((entrypoint) => entrypoint.declarationEntryPoint));
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
    releasedBaselinePath: path(input["releasedBaselinePath"], `${field}.releasedBaselinePath`)
  };
  return Object.freeze({
    ...common,
    entrypoints,
    nonTypeExports,
    approvedBreakingChanges: Object.freeze(
      approvals.map((approval, approvalIndex) =>
        mapApproval(approval, index, approvalIndex)
      )
    )
  });
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
  schemaVersion(root["schemaVersion"]);
  await assertSchema(
    PUBLIC_API_COMPATIBILITY_SCHEMA_ID,
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
  const governanceConfigPathValue = root["governanceConfigPath"];
  const governancePath =
    governanceConfigPathValue === undefined
      ? undefined
      : governanceConfigPath(governanceConfigPathValue);
  const common = {
    changesetDirectory: path(root["changesetDirectory"], "changesetDirectory"),
    packages: Object.freeze(
      packages.map((packagePolicy, index) => mapPackage(packagePolicy, index))
    )
  };
  const hasBreakingApprovals = common.packages.some(
    (packagePolicy) => packagePolicy.approvedBreakingChanges.length > 0
  );
  const policy: PublicApiCompatibilityPolicy = Object.freeze({
    schemaVersion: 1,
    acceptedDecisionBaselinePath:
      decisionBaselinePath ??
      inputError("schemaVersion 1 requires acceptedDecisionBaselinePath."),
    ...(governancePath === undefined ? {} : { governanceConfigPath: governancePath }),
    changesetDirectory: common.changesetDirectory,
    packages: common.packages
  });
  if (hasBreakingApprovals && policy.governanceConfigPath === undefined) {
    inputError("governanceConfigPath is required when breaking approvals are declared.");
  }
  validatePolicy(policy);
  return policy;
}

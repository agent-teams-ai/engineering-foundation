import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  assertRepositoryRelativePath,
  loadStrictYamlFile
} from "../../../strict-yaml.js";
import type {
  ApprovedBreakingChange,
  PublicApiCompatibilityPolicy,
  PublicApiPackagePolicy
} from "../application/model/public-api.js";

export const CAPABILITY_ID = "package.public-api-compatibility" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

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

function mapPackage(value: unknown, index: number): PublicApiPackagePolicy {
  const field = `packages[${index}]`;
  const input = record(value, field);
  const packageRoot = path(input["packageRoot"], `${field}.packageRoot`);
  const manifestPath = path(input["manifestPath"], `${field}.manifestPath`);
  const declarationEntryPoint = path(
    input["declarationEntryPoint"],
    `${field}.declarationEntryPoint`
  );
  const tsconfigPath = path(input["tsconfigPath"], `${field}.tsconfigPath`);
  const approvals = input["approvedBreakingChanges"];
  if (!Array.isArray(approvals)) {
    inputError(`${field}.approvedBreakingChanges must be an array.`);
  }
  for (const repositoryPath of [manifestPath, declarationEntryPoint, tsconfigPath]) {
    if (!pathInside(repositoryPath, packageRoot)) {
      inputError(`${repositoryPath} must be inside package root ${packageRoot}.`);
    }
  }
  return Object.freeze({
    packageName: string(input["packageName"], `${field}.packageName`),
    packageRoot,
    manifestPath,
    declarationEntryPoint,
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
  await assertSchema(
    "package-public-api-compatibility/v1",
    input,
    "public-api-compatibility-config"
  );
  const root = record(input, "public API compatibility config");
  const packages = root["packages"];
  if (!Array.isArray(packages)) {
    inputError("packages must be an array.");
  }
  const policy: PublicApiCompatibilityPolicy = Object.freeze({
    changesetDirectory: path(root["changesetDirectory"], "changesetDirectory"),
    packages: Object.freeze(packages.map(mapPackage))
  });
  validatePolicy(policy);
  return policy;
}

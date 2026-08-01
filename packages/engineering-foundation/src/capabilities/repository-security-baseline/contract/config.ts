import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { assertRepositoryRelativePath, loadStrictYamlFile } from "../../../strict-yaml.js";
import type {
  PrivilegedJobPolicy,
  RepositorySecurityPolicy,
  WorkflowPermission
} from "../application/model/repository-security.js";

export const CAPABILITY_ID = "repository.security-baseline" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "REPOSITORY_SECURITY_CONFIG_INVALID",
    message,
    phase: "repository-security-config",
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
  const result = string(value, field);
  assertRepositoryRelativePath(result, "repository-security-config");
  return result;
}

function mapPrivilegedJob(value: unknown, index: number): PrivilegedJobPolicy {
  const field = `privilegedJobs[${index}]`;
  const input = record(value, field);
  const permissionInput = record(input["permissions"], `${field}.permissions`);
  const permissions: Record<string, WorkflowPermission> = {};
  for (const [name, permission] of Object.entries(permissionInput)) {
    if (permission !== "none" && permission !== "read" && permission !== "write") {
      inputError(`${field}.permissions.${name} is invalid.`);
    }
    permissions[name] = permission;
  }
  if (!Object.values(permissions).includes("write")) {
    inputError(`${field} must govern at least one write permission.`);
  }
  return Object.freeze({
    workflowPath: path(input["workflowPath"], `${field}.workflowPath`),
    jobId: string(input["jobId"], `${field}.jobId`),
    permissions: Object.freeze(permissions)
  });
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<RepositorySecurityPolicy> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "repository-security-config",
    signal
  );
  await assertSchema("repository-security-baseline/v1", input, "repository-security-config");
  const root = record(input, "repository security config");
  const workflowDirectory = path(root["workflowDirectory"], "workflowDirectory");
  const dependencyReviewWorkflow = path(
    root["dependencyReviewWorkflow"],
    "dependencyReviewWorkflow"
  );
  const sbomWorkflow = path(root["sbomWorkflow"], "sbomWorkflow");
  for (const governedWorkflow of [dependencyReviewWorkflow, sbomWorkflow]) {
    if (!governedWorkflow.startsWith(`${workflowDirectory}/`)) {
      inputError(`${governedWorkflow} must be inside workflowDirectory.`);
    }
  }
  const privilegedInput = root["privilegedJobs"];
  const manifestsInput = root["publishablePackageManifests"];
  if (!Array.isArray(privilegedInput) || !Array.isArray(manifestsInput)) {
    inputError("privilegedJobs and publishablePackageManifests must be arrays.");
  }
  const privilegedJobs = privilegedInput.map(mapPrivilegedJob);
  const privilegedKeys = privilegedJobs.map(({ workflowPath, jobId }) => `${workflowPath}:${jobId}`);
  if (new Set(privilegedKeys).size !== privilegedKeys.length) {
    inputError("Privileged workflow job declarations must be unique.");
  }
  for (const privileged of privilegedJobs) {
    if (!privileged.workflowPath.startsWith(`${workflowDirectory}/`)) {
      inputError(`Privileged workflow must be inside ${workflowDirectory}: ${privileged.workflowPath}.`);
    }
  }
  return Object.freeze({
    workflowDirectory,
    dependencyReviewWorkflow,
    sbomWorkflow,
    privilegedJobs: Object.freeze(privilegedJobs),
    publishablePackageManifests: Object.freeze(
      manifestsInput.map((value, index) => path(value, `publishablePackageManifests[${index}]`))
    )
  });
}

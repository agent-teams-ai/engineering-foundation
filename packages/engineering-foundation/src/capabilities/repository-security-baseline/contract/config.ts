import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { assertRepositoryRelativePath, loadStrictYamlFile } from "../../../strict-yaml.js";
import type {
  AllowedWorkflowUse,
  DependencyReviewPolicy,
  PrivilegedJobPolicy,
  RepositorySecurityPolicy,
  RepositorySecurityToolPolicies,
  RepositorySecurityToolPolicy,
  SecurityToolName,
  ToolEvidenceRollout,
  WorkflowPermission
} from "../application/model/repository-security.js";
import {
  configuredRepositorySecurityTools,
  flattenAllowedWorkflowUses,
  isPinnedContainerImage,
  isPinnedExternalWorkflowUse
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

function rollout(value: unknown, field: string): ToolEvidenceRollout {
  if (value !== "advisory" && value !== "blocking") {
    inputError(`${field} must be advisory or blocking.`);
  }
  return value;
}

function version(value: unknown, field: string): string {
  const result = string(value, field);
  if (
    !/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      result
    )
  ) {
    inputError(`${field} must be an exact semantic version.`);
  }
  return result;
}

function pinnedExternalUse(value: unknown, field: string): string {
  const result = string(value, field);
  if (!isPinnedExternalWorkflowUse(result)) {
    inputError(`${field} must be an immutable external action, reusable workflow, or container digest.`);
  }
  return result;
}

function mapToolEvidencePolicy(
  value: unknown,
  tool: SecurityToolName
): RepositorySecurityToolPolicy {
  const field = `toolEvidence.${tool}`;
  const input = record(value, field);
  return Object.freeze({
    configPath: path(input["configPath"], `${field}.configPath`),
    evidencePath: path(input["evidencePath"], `${field}.evidencePath`),
    invocationUse: pinnedExternalUse(input["invocationUse"], `${field}.invocationUse`),
    jobId: string(input["jobId"], `${field}.jobId`),
    resultPath: path(input["resultPath"], `${field}.resultPath`),
    rollout: rollout(input["rollout"], `${field}.rollout`),
    version: version(input["version"], `${field}.version`),
    workflowPath: path(input["workflowPath"], `${field}.workflowPath`)
  });
}

function mapToolEvidencePolicies(value: unknown): RepositorySecurityToolPolicies {
  const input = record(value, "toolEvidence");
  const actionlint = mapToolEvidencePolicy(input["actionlint"], "actionlint");
  const zizmor = mapToolEvidencePolicy(input["zizmor"], "zizmor");
  const codeql = input["codeql"] === undefined ? undefined : mapToolEvidencePolicy(input["codeql"], "codeql");
  const policies = [actionlint, zizmor, ...(codeql === undefined ? [] : [codeql])];
  const artifactPaths = policies.flatMap(({ evidencePath, resultPath }) => [
    evidencePath,
    resultPath
  ]);
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    inputError("Each security tool must declare independent evidence and result paths.");
  }
  const jobKeys = policies.map(({ jobId, workflowPath }) => `${workflowPath}:${jobId}`);
  if (new Set(jobKeys).size !== jobKeys.length) {
    inputError("Each security tool must declare an independent workflow job.");
  }
  return Object.freeze({
    actionlint,
    zizmor,
    ...(codeql === undefined ? {} : { codeql })
  });
}

function mapAllowedUse(value: unknown, field: string, depth: number): AllowedWorkflowUse {
  if (depth > 10) {
    inputError(`${field} exceeds the supported transitive allowlist depth.`);
  }
  const input = record(value, field);
  const use = pinnedExternalUse(input["uses"], `${field}.uses`);
  const transitiveInput = input["transitiveUses"];
  if (!Array.isArray(transitiveInput)) {
    inputError(`${field}.transitiveUses must be an array.`);
  }
  return Object.freeze({
    uses: use,
    transitiveUses: Object.freeze(
      transitiveInput.map((entry, index) =>
        mapAllowedUse(entry, `${field}.transitiveUses[${index}]`, depth + 1)
      )
    )
  });
}

function mapAllowedUses(value: unknown): readonly AllowedWorkflowUse[] {
  if (!Array.isArray(value)) {
    inputError("allowedUses must be an array.");
  }
  const entries = value.map((entry, index) => mapAllowedUse(entry, `allowedUses[${index}]`, 1));
  const flattened = flattenAllowedWorkflowUses(entries).map(({ uses }) => uses);
  if (new Set(flattened).size !== flattened.length) {
    inputError("allowedUses and transitiveUses entries must be globally unique.");
  }
  return Object.freeze(entries);
}

function mapAllowedContainerImages(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    inputError("allowedContainerImages must be an array.");
  }
  const images = value.map((entry, index) => {
    const field = `allowedContainerImages[${index}]`;
    const image = string(entry, field);
    if (!isPinnedContainerImage(image)) {
      inputError(`${field} must be an immutable container image digest.`);
    }
    return image;
  });
  if (new Set(images).size !== images.length) {
    inputError("allowedContainerImages entries must be unique.");
  }
  return Object.freeze(images);
}

function mapDependencyReview(value: unknown): DependencyReviewPolicy {
  const input = record(value, "dependencyReview");
  const baseRef = string(input["baseRef"], "dependencyReview.baseRef");
  const headRef = string(input["headRef"], "dependencyReview.headRef");
  if (baseRef.trim().length === 0 || headRef.trim().length === 0 || baseRef === headRef) {
    inputError("dependencyReview baseRef and headRef must be distinct non-empty expressions.");
  }
  const failOnSeverity = string(
    input["failOnSeverity"],
    "dependencyReview.failOnSeverity"
  );
  if (failOnSeverity !== "low" && failOnSeverity !== "moderate") {
    inputError("dependencyReview.failOnSeverity must be low or moderate.");
  }
  return Object.freeze({
    baseRef,
    failOnSeverity,
    headRef,
    jobId: string(input["jobId"], "dependencyReview.jobId"),
    workflowPath: path(input["workflowPath"], "dependencyReview.workflowPath")
  });
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
  const dependencyReview = mapDependencyReview(root["dependencyReview"]);
  const sbomWorkflow = path(root["sbomWorkflow"], "sbomWorkflow");
  for (const governedWorkflow of [dependencyReview.workflowPath, sbomWorkflow]) {
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
  const allowedUses = mapAllowedUses(root["allowedUses"]);
  const allowedContainerImages = mapAllowedContainerImages(root["allowedContainerImages"]);
  const toolEvidence =
    root["toolEvidence"] === undefined
      ? undefined
      : mapToolEvidencePolicies(root["toolEvidence"]);
  for (const tool of configuredRepositorySecurityTools(toolEvidence)) {
    if (!tool.policy.workflowPath.startsWith(`${workflowDirectory}/`)) {
      inputError(`${tool.policy.workflowPath} must be inside workflowDirectory.`);
    }
  }
  return Object.freeze({
    allowedContainerImages,
    allowedUses,
    workflowDirectory,
    dependencyReview,
    sbomWorkflow,
    privilegedJobs: Object.freeze(privilegedJobs),
    publishablePackageManifests: Object.freeze(
      manifestsInput.map((value, index) => path(value, `publishablePackageManifests[${index}]`))
    ),
    ...(toolEvidence === undefined ? {} : { toolEvidence })
  });
}

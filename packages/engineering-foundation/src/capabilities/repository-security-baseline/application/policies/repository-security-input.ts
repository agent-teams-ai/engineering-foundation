import { CapabilityInputError, assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import type { RepositorySecurityEvidence, RepositorySecurityPolicy } from "../model/repository-security.js";

export function repositorySecurityInputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "repository-security-evidence",
    retryable: false
  });
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_EVIDENCE_INVALID",
      `${field} must be an object.`
    );
  }
  return value as Record<string, unknown>;
}

export function requireConfiguredWorkflows(
  workflows: RepositorySecurityEvidence["workflows"],
  policy: RepositorySecurityPolicy
): void {
  for (const requiredWorkflow of [policy.dependencyReview.workflowPath, policy.sbomWorkflow]) {
    if (!workflows.some(({ path }) => path === requiredWorkflow)) {
      repositorySecurityInputError(
        "REPOSITORY_SECURITY_REQUIRED_WORKFLOW_UNAVAILABLE",
        `Required security workflow is not discovered: ${requiredWorkflow}.`
      );
    }
  }
}

export function assertSecurityObservationActive(signal: AbortSignal | undefined): void {
  assertNotCancelled(signal);
}

export type WorkflowPermission = "none" | "read" | "write";
export type ToolEvidenceRollout = "advisory" | "blocking";
export type SecurityToolName = "actionlint" | "zizmor" | "codeql";

const FULL_SHA_ACTION =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-fA-F]{40}$/u;
const FULL_DIGEST_CONTAINER = /^docker:\/\/.+@sha256:[0-9a-fA-F]{64}$/u;

function isLocalWorkflowUse(value: string): boolean {
  return value.startsWith("./");
}

export function isSafeLocalWorkflowUse(value: string): boolean {
  return (
    isLocalWorkflowUse(value) &&
    !value.split("/").includes("..") &&
    !value.includes("${{")
  );
}

export function isPinnedExternalWorkflowUse(value: string): boolean {
  return FULL_SHA_ACTION.test(value) || FULL_DIGEST_CONTAINER.test(value);
}

export interface WorkflowStepEvidence {
  readonly conditional: boolean;
  readonly nonBlocking: boolean;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly uses?: string;
  readonly run?: string;
}

export interface WorkflowJobEvidence {
  readonly conditional: boolean;
  readonly nonBlocking: boolean;
  readonly id: string;
  readonly uses?: string;
  readonly permissions?: Readonly<Record<string, WorkflowPermission>> | "read-all" | "write-all";
  readonly steps: readonly WorkflowStepEvidence[];
}

export interface WorkflowEvidence {
  readonly path: string;
  readonly triggers: readonly string[];
  readonly unconditionalTriggers: readonly string[];
  readonly permissions?: Readonly<Record<string, WorkflowPermission>> | "read-all" | "write-all";
  readonly jobs: readonly WorkflowJobEvidence[];
}

export interface WorkflowUseEvidence {
  readonly path: string;
  readonly subject: string;
  readonly uses: string;
}

export interface PublishablePackageEvidence {
  readonly manifestPath: string;
  readonly packageName: string;
  readonly files?: readonly string[];
  readonly provenance: boolean;
}

export interface RepositorySecurityEvidence {
  readonly workflows: readonly WorkflowEvidence[];
  readonly workflowUses: readonly WorkflowUseEvidence[];
  readonly workflowDigest: string;
  readonly packages: readonly PublishablePackageEvidence[];
  readonly toolEvidence: readonly RepositorySecurityToolEvidence[];
}

export interface RepositorySecurityToolPolicy {
  readonly configPath: string;
  readonly evidencePath: string;
  readonly invocationUse: string;
  readonly jobId: string;
  readonly resultPath: string;
  readonly rollout: ToolEvidenceRollout;
  readonly version: string;
  readonly workflowPath: string;
}

export interface RepositorySecurityToolPolicies {
  readonly actionlint: RepositorySecurityToolPolicy;
  readonly zizmor: RepositorySecurityToolPolicy;
  readonly codeql?: RepositorySecurityToolPolicy;
}

export function configuredRepositorySecurityTools(
  policies: RepositorySecurityToolPolicies | undefined
): readonly { readonly policy: RepositorySecurityToolPolicy; readonly tool: SecurityToolName }[] {
  if (policies === undefined) {
    return [];
  }
  return [
    { tool: "actionlint", policy: policies.actionlint },
    { tool: "zizmor", policy: policies.zizmor },
    ...(policies.codeql === undefined
      ? []
      : [{ tool: "codeql" as const, policy: policies.codeql }])
  ];
}

interface BaseRepositorySecurityToolEvidence {
  readonly evidencePath: string;
  readonly resultPath: string;
  readonly tool: SecurityToolName;
}

interface MissingRepositorySecurityToolEvidence
  extends BaseRepositorySecurityToolEvidence {
  readonly kind: "missing";
  readonly missing: "evidence" | "result";
}

export interface PresentRepositorySecurityToolEvidence
  extends BaseRepositorySecurityToolEvidence {
  readonly actualConfigDigest: string;
  readonly actualResultDigest: string;
  readonly actualWorkflowDigest: string;
  readonly configDigest: string;
  readonly kind: "present";
  readonly outcome: "failed" | "passed";
  readonly resultDigest: string;
  readonly toolVersion: string;
  readonly workflowDigest: string;
}

export type RepositorySecurityToolEvidence =
  | MissingRepositorySecurityToolEvidence
  | PresentRepositorySecurityToolEvidence;

export interface AllowedWorkflowUse {
  readonly transitiveUses: readonly AllowedWorkflowUse[];
  readonly uses: string;
}

export interface AllowedWorkflowUseEntry {
  readonly direct: boolean;
  readonly uses: string;
}

export function flattenAllowedWorkflowUses(
  entries: readonly AllowedWorkflowUse[]
): readonly AllowedWorkflowUseEntry[] {
  const flattened: AllowedWorkflowUseEntry[] = [];
  const append = (candidates: readonly AllowedWorkflowUse[], direct: boolean): void => {
    for (const candidate of candidates) {
      flattened.push({ direct, uses: candidate.uses });
      append(candidate.transitiveUses, false);
    }
  };
  append(entries, true);
  return Object.freeze(flattened);
}

export interface PrivilegedJobPolicy {
  readonly workflowPath: string;
  readonly jobId: string;
  readonly permissions: Readonly<Record<string, WorkflowPermission>>;
}

export interface RepositorySecurityPolicy {
  readonly allowedUses?: readonly AllowedWorkflowUse[];
  readonly workflowDirectory: string;
  readonly dependencyReviewWorkflow: string;
  readonly sbomWorkflow: string;
  readonly privilegedJobs: readonly PrivilegedJobPolicy[];
  readonly publishablePackageManifests: readonly string[];
  readonly toolEvidence?: RepositorySecurityToolPolicies;
}

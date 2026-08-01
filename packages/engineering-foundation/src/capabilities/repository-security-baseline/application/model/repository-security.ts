export type WorkflowPermission = "none" | "read" | "write";

export interface WorkflowStepEvidence {
  readonly uses?: string;
  readonly run?: string;
}

export interface WorkflowJobEvidence {
  readonly id: string;
  readonly uses?: string;
  readonly permissions?: Readonly<Record<string, WorkflowPermission>> | "read-all" | "write-all";
  readonly steps: readonly WorkflowStepEvidence[];
}

export interface WorkflowEvidence {
  readonly path: string;
  readonly triggers: readonly string[];
  readonly permissions?: Readonly<Record<string, WorkflowPermission>> | "read-all" | "write-all";
  readonly jobs: readonly WorkflowJobEvidence[];
}

export interface PublishablePackageEvidence {
  readonly manifestPath: string;
  readonly packageName: string;
  readonly files?: readonly string[];
  readonly provenance: boolean;
}

export interface RepositorySecurityEvidence {
  readonly workflows: readonly WorkflowEvidence[];
  readonly packages: readonly PublishablePackageEvidence[];
}

export interface PrivilegedJobPolicy {
  readonly workflowPath: string;
  readonly jobId: string;
  readonly permissions: Readonly<Record<string, WorkflowPermission>>;
}

export interface RepositorySecurityPolicy {
  readonly workflowDirectory: string;
  readonly dependencyReviewWorkflow: string;
  readonly sbomWorkflow: string;
  readonly privilegedJobs: readonly PrivilegedJobPolicy[];
  readonly publishablePackageManifests: readonly string[];
}

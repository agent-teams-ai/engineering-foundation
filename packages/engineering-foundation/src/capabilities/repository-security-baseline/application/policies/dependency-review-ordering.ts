import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type {
  RepositorySecurityPolicy,
  WorkflowEvidence,
  WorkflowJobEvidence,
  WorkflowStepEvidence
} from "../model/repository-security.js";
import { isPinnedExternalWorkflowUse } from "../model/repository-security.js";
import { REPOSITORY_SECURITY_RULES } from "../rules.js";
import { repositorySecurityDiagnostic as diagnostic } from "./repository-security-diagnostic.js";

interface RepositoryCodeExecution {
  readonly kind: "local-action" | "reusable-workflow" | "run-step";
  readonly value: string;
}

const EXPLICIT_STATUS_FUNCTION = /\b(?:always|cancelled|failure|success)\s*\(/iu;

function overridesImplicitSuccessGate(
  value: WorkflowJobEvidence | WorkflowStepEvidence
): boolean {
  // GitHub implicitly prepends success() only when an if expression contains no
  // status function. Exact success() is also provable; all more complex status
  // expressions fail closed because arbitrary expression equivalence is outside
  // this policy.
  if (value.condition === undefined || !EXPLICIT_STATUS_FUNCTION.test(value.condition)) {
    return false;
  }
  const normalized = value.condition
    .trim()
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\s*\}\}$/u, "")
    .trim();
  return normalized !== "success()";
}

function inputIsEnabledOrAbsent(step: WorkflowStepEvidence, name: string): boolean {
  const value = step.inputs[name];
  return (
    value === undefined ||
    value === true ||
    (typeof value === "string" && value.toLowerCase() === "true")
  );
}

function hasDependencyReviewSemantics(
  policy: RepositorySecurityPolicy,
  job: WorkflowJobEvidence,
  step: WorkflowStepEvidence
): boolean {
  return (
    job.id === policy.dependencyReview.jobId &&
    !job.conditional &&
    !job.nonBlocking &&
    !step.conditional &&
    !step.nonBlocking &&
    step.inputs["base-ref"] === policy.dependencyReview.baseRef &&
    step.inputs["head-ref"] === policy.dependencyReview.headRef &&
    step.inputs["fail-on-severity"] === policy.dependencyReview.failOnSeverity &&
    inputIsEnabledOrAbsent(step, "vulnerability-check") &&
    (step.inputs["warn-only"] === false || step.inputs["warn-only"] === "false") &&
    step.inputs["config-file"] === undefined &&
    step.inputs["fail-on-scopes"] === undefined &&
    step.inputs["allow-ghsas"] === undefined &&
    step.uses?.startsWith("actions/dependency-review-action@") === true &&
    isPinnedExternalWorkflowUse(step.uses)
  );
}

export function isDependencyReviewEvidence(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  job: WorkflowJobEvidence,
  step: WorkflowStepEvidence
): boolean {
  return (
    workflow.path === policy.dependencyReview.workflowPath &&
    workflow.pullRequestCodeChangesCovered &&
    hasDependencyReviewSemantics(policy, job, step)
  );
}

function repositoryCodeExecutionFromStep(
  step: WorkflowStepEvidence
): RepositoryCodeExecution | undefined {
  if (step.run !== undefined) {
    return Object.freeze({ kind: "run-step", value: step.run });
  }
  if (step.uses?.startsWith(".") === true) {
    return Object.freeze({ kind: "local-action", value: step.uses });
  }
  return undefined;
}

function repositoryCodeExecutionFromJob(
  job: WorkflowJobEvidence
): RepositoryCodeExecution | undefined {
  if (job.uses?.startsWith(".") === true) {
    return Object.freeze({ kind: "reusable-workflow", value: job.uses });
  }
  return undefined;
}

function isPullRequestWorkflow(workflow: WorkflowEvidence): boolean {
  return (
    workflow.triggers.includes("pull_request") ||
    workflow.triggers.includes("pull_request_target")
  );
}

function validLocalDependencyReviewJob(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence
): WorkflowJobEvidence | undefined {
  const reviewJob = workflow.jobs.find((candidate) => candidate.id === policy.dependencyReview.jobId);
  if (
    !workflow.triggers.includes("pull_request") ||
    reviewJob === undefined ||
    !reviewJob.steps.some((step) =>
      hasDependencyReviewSemantics(policy, reviewJob, step)
    )
  ) {
    return undefined;
  }
  return reviewJob;
}

function dependsOnDeclaredDependencyReview(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  job: WorkflowJobEvidence,
  reviewJob: WorkflowJobEvidence
): boolean {
  if (job.nonBlocking || overridesImplicitSuccessGate(job)) {
    return false;
  }
  const jobsById = new Map(workflow.jobs.map((candidate) => [candidate.id, candidate]));
  const dependsOnReview = (jobId: string, ancestors: ReadonlySet<string>): boolean => {
    if (ancestors.has(jobId)) {
      return false;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(jobId);
    const candidate = jobsById.get(jobId);
    if (
      candidate === undefined ||
      candidate.nonBlocking ||
      overridesImplicitSuccessGate(candidate)
    ) {
      return false;
    }
    if (candidate.id === reviewJob.id) {
      return true;
    }
    return candidate.needs.some((dependency) => dependsOnReview(dependency, nextAncestors));
  };
  return job.needs.some((dependency) => dependsOnReview(dependency, new Set()));
}

function orderingDiagnostic(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  job: WorkflowJobEvidence,
  execution: RepositoryCodeExecution
): FoundationDiagnostic {
  return diagnostic({
    rule: REPOSITORY_SECURITY_RULES.dependencyReviewOrdering,
    subject: `${workflow.path}:${job.id}`,
    path: workflow.path,
    message: "A pull-request workflow can execute before the declared Dependency Review gate.",
    evidence: [
      { kind: "dependency-review-job", value: policy.dependencyReview.jobId },
      { kind: "repository-code-execution", value: execution.kind },
      { kind: "repository-code-command", value: execution.value }
    ]
  });
}

export function inspectDependencyReviewOrdering(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  job: WorkflowJobEvidence,
  diagnostics: FoundationDiagnostic[]
): void {
  if (!isPullRequestWorkflow(workflow)) {
    return;
  }
  const reviewJob = validLocalDependencyReviewJob(policy, workflow);
  if (workflow.path === policy.dependencyReview.workflowPath && reviewJob === undefined) {
    return;
  }
  const dependsOnBlockingReview =
    reviewJob === undefined
      ? false
      : dependsOnDeclaredDependencyReview(policy, workflow, job, reviewJob);
  const jobExecution = repositoryCodeExecutionFromJob(job);
  if (jobExecution !== undefined && !dependsOnBlockingReview) {
    diagnostics.push(orderingDiagnostic(policy, workflow, job, jobExecution));
    return;
  }
  let reviewHasRunInJob = false;
  for (const step of job.steps) {
    if (hasDependencyReviewSemantics(policy, job, step)) {
      reviewHasRunInJob = true;
    }
    const execution = repositoryCodeExecutionFromStep(step);
    const sameJobGateCanBeBypassed = reviewHasRunInJob && overridesImplicitSuccessGate(step);
    if (
      execution !== undefined &&
      ((!reviewHasRunInJob && !dependsOnBlockingReview) || sameJobGateCanBeBypassed)
    ) {
      diagnostics.push(orderingDiagnostic(policy, workflow, job, execution));
      return;
    }
  }
}

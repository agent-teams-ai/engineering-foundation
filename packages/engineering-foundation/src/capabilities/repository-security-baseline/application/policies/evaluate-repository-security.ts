import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type {
  CompositeActionEvidence,
  PrivilegedJobPolicy,
  RepositorySecurityEvidence,
  RepositorySecurityPolicy,
  WorkflowJobEvidence,
  WorkflowPermission
} from "../model/repository-security.js";
import {
  isPinnedContainerImage,
  isPinnedExternalWorkflowUse,
  isSafeLocalWorkflowUse
} from "../model/repository-security.js";
import { REPOSITORY_SECURITY_RULES } from "../rules.js";
import {
  inspectDependencyReviewOrdering,
  isDependencyReviewEvidence
} from "./dependency-review-ordering.js";
import { evaluateRepositorySecurityTools } from "./evaluate-repository-security-tools.js";
import { evaluateRepositoryWorkflowUses } from "./evaluate-repository-workflow-uses.js";
import { repositorySecurityDiagnostic as diagnostic } from "./repository-security-diagnostic.js";

const UNSAFE_PACKAGE_SEGMENT = /^(?:\.env(?:\..*)?|\.git|node_modules|src|tests?|auth\.json)$/iu;
const PACKAGE_PATH_META = /[*?{}[\]\\]/u;
const UNTRUSTED_EXPRESSION_IN_RUN =
  /\$\{\{[^}]*github\s*(?:\.\s*(?:event|head_ref)\b|\[\s*["'](?:event|head_ref)["']\s*\])/iu;

function exactPermissions(
  actual: Readonly<Record<string, WorkflowPermission>>,
  expected: Readonly<Record<string, WorkflowPermission>>
): boolean {
  const actualEntries = Object.entries(actual).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const expectedEntries = Object.entries(expected).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function policyForJob(
  policy: RepositorySecurityPolicy,
  workflowPath: string,
  jobId: string
): PrivilegedJobPolicy | undefined {
  return policy.privilegedJobs.find(
    (candidate) => candidate.workflowPath === workflowPath && candidate.jobId === jobId
  );
}

function actionPinned(action: string): boolean {
  if (isSafeLocalWorkflowUse(action)) {
    return true;
  }
  return isPinnedExternalWorkflowUse(action);
}

function jobPermissions(
  job: WorkflowJobEvidence,
  workflowPermissions: RepositorySecurityEvidence["workflows"][number]["permissions"]
) {
  return job.permissions ?? workflowPermissions;
}

function inputIsEnabledOrAbsent(
  step: WorkflowJobEvidence["steps"][number],
  name: string
): boolean {
  const value = step.inputs[name];
  return (
    value === undefined ||
    value === true ||
    (typeof value === "string" && value.toLowerCase() === "true")
  );
}

function scansRepositoryRoot(step: WorkflowJobEvidence["steps"][number]): boolean {
  const path = step.inputs["path"];
  return (
    (path === undefined || path === "." || path === "./") &&
    step.inputs["file"] === undefined &&
    step.inputs["image"] === undefined
  );
}

function unsafePackagePath(entry: string): boolean {
  if (
    entry.length === 0 ||
    entry.startsWith("/") ||
    entry.includes("//") ||
    PACKAGE_PATH_META.test(entry)
  ) {
    return true;
  }
  const segments = entry.split("/");
  return segments.some(
    (segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      UNSAFE_PACKAGE_SEGMENT.test(segment)
  );
}

type WorkflowEvidence = RepositorySecurityEvidence["workflows"][number];
type PackageEvidence = RepositorySecurityEvidence["packages"][number];

interface EvaluationState {
  readonly diagnostics: FoundationDiagnostic[];
  readonly seenContainerImages: Set<string>;
  readonly seenPullRequestTargetWorkflows: Set<string>;
  readonly seenPrivilegedJobs: Set<string>;
  dependencyReviewFound: boolean;
  sbomFound: boolean;
}

function inspectContainerImage(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  job: WorkflowEvidence["jobs"][number],
  container: WorkflowEvidence["jobs"][number]["containers"][number],
  state: EvaluationState
): void {
  const subject = `${workflow.path}:${job.id}.${container.scope}.${container.name}`;
  if (!isPinnedContainerImage(container.image)) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.containerNotPinned,
        subject,
        path: workflow.path,
        message: `Container image is not pinned to an immutable digest: ${container.image}.`,
        evidence: [{ kind: "container-image", value: container.image }]
      })
    );
    return;
  }
  state.seenContainerImages.add(container.image);
  if (!policy.allowedContainerImages.includes(container.image)) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.containerNotAllowlisted,
        subject,
        path: workflow.path,
        message: `Pinned container image is not declared in allowedContainerImages: ${container.image}.`,
        evidence: [{ kind: "container-image", value: container.image }]
      })
    );
  }
}

function isSbomEvidence(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  job: WorkflowEvidence["jobs"][number],
  step: WorkflowEvidence["jobs"][number]["steps"][number]
): boolean {
  return (
    workflow.path === policy.sbomWorkflow &&
    workflow.pullRequestCodeChangesCovered &&
    !job.conditional &&
    !job.nonBlocking &&
    !step.conditional &&
    !step.nonBlocking &&
    inputIsEnabledOrAbsent(step, "upload-artifact") &&
    scansRepositoryRoot(step) &&
    step.uses?.startsWith("anchore/sbom-action@") === true &&
    actionPinned(step.uses)
  );
}

function inspectWorkflowRoot(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  state: EvaluationState
): void {
  if (
    workflow.permissions === undefined ||
    typeof workflow.permissions === "string" ||
    Object.values(workflow.permissions).some((value) => value === "write")
  ) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.permissionsInvalid,
        subject: workflow.path,
        path: workflow.path,
        message: "Workflow root permissions are missing, broad, or write-capable."
      })
    );
  }
  if (workflow.triggers.includes("pull_request_target")) {
    if (policy.allowedPullRequestTargetWorkflows.includes(workflow.path)) {
      state.seenPullRequestTargetWorkflows.add(workflow.path);
    } else {
      state.diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.dangerousTrigger,
          subject: workflow.path,
          path: workflow.path,
          message: "Workflow uses undeclared pull_request_target."
        })
      );
    }
  }
}

function inspectWorkflowStep(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  job: WorkflowEvidence["jobs"][number],
  step: WorkflowEvidence["jobs"][number]["steps"][number],
  state: EvaluationState
): void {
  const subject = `${workflow.path}:${job.id}`;
  if (step.uses !== undefined && !actionPinned(step.uses)) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.actionNotPinned,
        subject,
        path: workflow.path,
        message: `Action is not pinned to immutable evidence: ${step.uses}.`,
        evidence: [{ kind: "action", value: step.uses }]
      })
    );
  }
  if (step.run !== undefined && UNTRUSTED_EXPRESSION_IN_RUN.test(step.run)) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.eventInterpolationInRun,
        subject,
        path: workflow.path,
        message: "Shell script directly interpolates github.event data."
      })
    );
  }
  if (isDependencyReviewEvidence(policy, workflow, job, step)) {
    state.dependencyReviewFound = true;
  }
  if (isSbomEvidence(policy, workflow, job, step)) {
    state.sbomFound = true;
  }
}

function inspectWorkflowJob(
  policy: RepositorySecurityPolicy,
  workflow: WorkflowEvidence,
  job: WorkflowEvidence["jobs"][number],
  state: EvaluationState
): void {
  const subject = `${workflow.path}:${job.id}`;
  const permissionSet = jobPermissions(job, workflow.permissions);
  const privileged = policyForJob(policy, workflow.path, job.id);
  if (privileged !== undefined) {
    state.seenPrivilegedJobs.add(subject);
  }
  const hasWrite =
    permissionSet === "write-all" ||
    (typeof permissionSet === "object" &&
      Object.values(permissionSet).some((value) => value === "write"));
  const privilegeMismatch = privileged === undefined
    ? hasWrite
    : typeof permissionSet !== "object" ||
      !exactPermissions(permissionSet, privileged.permissions);
  if (privilegeMismatch) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.privilegedJobMismatch,
        subject,
        path: workflow.path,
        message: "Job permissions do not match one exact privileged-job declaration."
      })
    );
  }
  if (job.uses !== undefined && !actionPinned(job.uses)) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.actionNotPinned,
        subject,
        path: workflow.path,
        message: `Reusable workflow is not pinned to immutable evidence: ${job.uses}.`,
        evidence: [{ kind: "action", value: job.uses }]
      })
    );
  }
  for (const container of job.containers) {
    inspectContainerImage(policy, workflow, job, container, state);
  }
  for (const step of job.steps) {
    inspectWorkflowStep(policy, workflow, job, step, state);
  }
}

function inspectCompositeAction(
  action: CompositeActionEvidence,
  diagnostics: FoundationDiagnostic[]
): void {
  for (const [index, step] of action.steps.entries()) {
    if (step.run !== undefined && UNTRUSTED_EXPRESSION_IN_RUN.test(step.run)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.eventInterpolationInRun,
          subject: `${action.path}:runs.steps[${index}]`,
          path: action.path,
          message: "Composite action shell script directly interpolates github.event data."
        })
      );
    }
  }
}

function inspectRequiredEvidence(
  policy: RepositorySecurityPolicy,
  state: EvaluationState
): void {
  if (!state.dependencyReviewFound) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.dependencyReviewMissing,
        subject: `${policy.dependencyReview.workflowPath}:${policy.dependencyReview.jobId}`,
        path: policy.dependencyReview.workflowPath,
        message: "Declared dependency-review workflow does not run the pinned official action."
      })
    );
  }
  if (!state.sbomFound) {
    state.diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.sbomMissing,
        subject: policy.sbomWorkflow,
        path: policy.sbomWorkflow,
        message: "Declared SBOM workflow does not run the pinned Anchore action."
      })
    );
  }
}

function inspectPackageEvidence(
  packageEvidence: PackageEvidence,
  diagnostics: FoundationDiagnostic[]
): void {
  if (!packageEvidence.provenance) {
    diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.packageProvenanceMissing,
        subject: packageEvidence.packageName,
        path: packageEvidence.manifestPath,
        message: "Publishable package does not enable npm provenance."
      })
    );
  }
  const unsafeFiles = packageEvidence.files?.filter(unsafePackagePath);
  if (
    packageEvidence.files === undefined ||
    packageEvidence.files.length === 0 ||
    (unsafeFiles !== undefined && unsafeFiles.length > 0)
  ) {
    diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.packageFilesUnsafe,
        subject: packageEvidence.packageName,
        path: packageEvidence.manifestPath,
        message: "Publishable package files allowlist is missing or unsafe.",
        evidence: (unsafeFiles ?? []).map((value) => ({ kind: "unsafe-path", value }))
      })
    );
  }
}

export function evaluateRepositorySecurity(
  policy: RepositorySecurityPolicy,
  evidence: RepositorySecurityEvidence
): readonly FoundationDiagnostic[] {
  const state: EvaluationState = {
    diagnostics: [],
    seenContainerImages: new Set<string>(),
    seenPullRequestTargetWorkflows: new Set<string>(),
    seenPrivilegedJobs: new Set<string>(),
    dependencyReviewFound: false,
    sbomFound: false
  };

  for (const workflow of evidence.workflows) {
    inspectWorkflowRoot(policy, workflow, state);
    for (const job of workflow.jobs) {
      inspectWorkflowJob(policy, workflow, job, state);
      inspectDependencyReviewOrdering(policy, workflow, job, state.diagnostics);
    }
  }
  for (const action of evidence.compositeActions) {
    inspectCompositeAction(action, state.diagnostics);
  }
  inspectRequiredEvidence(policy, state);
  for (const privileged of policy.privilegedJobs) {
    const key = `${privileged.workflowPath}:${privileged.jobId}`;
    if (!state.seenPrivilegedJobs.has(key)) {
      state.diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.stalePrivilegedJob,
          subject: key,
          path: privileged.workflowPath,
          message: "Privileged-job declaration has no matching workflow job."
        })
      );
    }
  }
  for (const workflowPath of policy.allowedPullRequestTargetWorkflows) {
    if (!state.seenPullRequestTargetWorkflows.has(workflowPath)) {
      state.diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.stalePullRequestTargetWorkflow,
          subject: workflowPath,
          path: workflowPath,
          message:
            "Allowed pull_request_target declaration has no matching workflow trigger."
        })
      );
    }
  }
  for (const image of policy.allowedContainerImages) {
    if (!state.seenContainerImages.has(image)) {
      state.diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.staleAllowedContainerImage,
          subject: image,
          path: policy.workflowDirectory,
          message: "Declared allowedContainerImages entry has no matching job or service container.",
          evidence: [{ kind: "container-image", value: image }]
        })
      );
    }
  }
  evaluateRepositoryWorkflowUses(policy, evidence, state.diagnostics);
  evaluateRepositorySecurityTools(policy, evidence, state.diagnostics);
  for (const packageEvidence of evidence.packages) {
    inspectPackageEvidence(packageEvidence, state.diagnostics);
  }
  return state.diagnostics;
}

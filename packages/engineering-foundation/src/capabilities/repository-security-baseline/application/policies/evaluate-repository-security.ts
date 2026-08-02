import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type {
  PrivilegedJobPolicy,
  RepositorySecurityEvidence,
  RepositorySecurityPolicy,
  WorkflowJobEvidence,
  WorkflowPermission
} from "../model/repository-security.js";
import {
  REPOSITORY_SECURITY_RULES,
  type RepositorySecurityRuleMetadata
} from "../rules.js";

const FULL_SHA_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-fA-F]{40}$/u;
const FULL_DIGEST_CONTAINER = /^docker:\/\/.+@sha256:[0-9a-fA-F]{64}$/u;
const UNSAFE_PACKAGE_SEGMENT = /^(?:\.env(?:\..*)?|\.git|node_modules|src|tests?|auth\.json)$/iu;
const PACKAGE_PATH_META = /[*?{}[\]\\]/u;
const UNTRUSTED_EXPRESSION_IN_RUN =
  /\$\{\{[^}]*github\s*(?:\.\s*(?:event|head_ref)\b|\[\s*["'](?:event|head_ref)["']\s*\])/iu;

function diagnostic(input: {
  readonly rule: RepositorySecurityRuleMetadata;
  readonly subject: string;
  readonly path: string;
  readonly message: string;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations: [],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

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
  if (action.startsWith("./")) {
    return !action.split("/").includes("..") && !action.includes("${{");
  }
  return FULL_SHA_ACTION.test(action) || FULL_DIGEST_CONTAINER.test(action);
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

function inputIsDisabledOrAbsent(
  step: WorkflowJobEvidence["steps"][number],
  name: string
): boolean {
  const value = step.inputs[name];
  return (
    value === undefined ||
    value === false ||
    (typeof value === "string" && value.toLowerCase() === "false")
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

export function evaluateRepositorySecurity(
  policy: RepositorySecurityPolicy,
  evidence: RepositorySecurityEvidence
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const seenPrivilegedJobs = new Set<string>();
  let dependencyReviewFound = false;
  let sbomFound = false;

  for (const workflow of evidence.workflows) {
    if (
      workflow.permissions === undefined ||
      typeof workflow.permissions === "string" ||
      Object.values(workflow.permissions).some((value) => value === "write")
    ) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.permissionsInvalid,
          subject: workflow.path,
          path: workflow.path,
          message: "Workflow root permissions are missing, broad, or write-capable."
        })
      );
    }
    if (workflow.triggers.includes("pull_request_target")) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.dangerousTrigger,
          subject: workflow.path,
          path: workflow.path,
          message: "Workflow uses prohibited pull_request_target."
        })
      );
    }
    for (const job of workflow.jobs) {
      const permissionSet = jobPermissions(job, workflow.permissions);
      const privileged = policyForJob(policy, workflow.path, job.id);
      if (privileged !== undefined) {
        seenPrivilegedJobs.add(`${workflow.path}:${job.id}`);
      }
      const hasWrite =
        permissionSet === "write-all" ||
        (typeof permissionSet === "object" &&
          Object.values(permissionSet).some((value) => value === "write"));
      const privilegeMismatch =
        privileged === undefined
          ? hasWrite
          : typeof permissionSet !== "object" ||
            !exactPermissions(permissionSet, privileged.permissions);
      if (privilegeMismatch) {
        diagnostics.push(
          diagnostic({
            rule: REPOSITORY_SECURITY_RULES.privilegedJobMismatch,
            subject: `${workflow.path}:${job.id}`,
            path: workflow.path,
            message: "Job permissions do not match one exact privileged-job declaration."
          })
        );
      }
      if (job.uses !== undefined && !actionPinned(job.uses)) {
        diagnostics.push(
          diagnostic({
            rule: REPOSITORY_SECURITY_RULES.actionNotPinned,
            subject: `${workflow.path}:${job.id}`,
            path: workflow.path,
            message: `Reusable workflow is not pinned to immutable evidence: ${job.uses}.`,
            evidence: [{ kind: "action", value: job.uses }]
          })
        );
      }
      for (const step of job.steps) {
        if (step.uses !== undefined && !actionPinned(step.uses)) {
          diagnostics.push(
            diagnostic({
              rule: REPOSITORY_SECURITY_RULES.actionNotPinned,
              subject: `${workflow.path}:${job.id}`,
              path: workflow.path,
              message: `Action is not pinned to immutable evidence: ${step.uses}.`,
              evidence: [{ kind: "action", value: step.uses }]
            })
          );
        }
        if (step.run !== undefined && UNTRUSTED_EXPRESSION_IN_RUN.test(step.run)) {
          diagnostics.push(
            diagnostic({
              rule: REPOSITORY_SECURITY_RULES.eventInterpolationInRun,
              subject: `${workflow.path}:${job.id}`,
              path: workflow.path,
              message: "Shell script directly interpolates github.event data."
            })
          );
        }
        if (
          workflow.path === policy.dependencyReviewWorkflow &&
          workflow.unconditionalTriggers.includes("pull_request") &&
          !job.conditional &&
          !job.nonBlocking &&
          !step.conditional &&
          !step.nonBlocking &&
          inputIsDisabledOrAbsent(step, "warn-only") &&
          step.inputs["config-file"] === undefined &&
          step.uses?.startsWith("actions/dependency-review-action@") === true &&
          actionPinned(step.uses)
        ) {
          dependencyReviewFound = true;
        }
        if (
          workflow.path === policy.sbomWorkflow &&
          workflow.unconditionalTriggers.includes("pull_request") &&
          !job.conditional &&
          !job.nonBlocking &&
          !step.conditional &&
          !step.nonBlocking &&
          inputIsEnabledOrAbsent(step, "upload-artifact") &&
          scansRepositoryRoot(step) &&
          step.uses?.startsWith("anchore/sbom-action@") === true &&
          actionPinned(step.uses)
        ) {
          sbomFound = true;
        }
      }
    }
  }

  if (!dependencyReviewFound) {
    diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.dependencyReviewMissing,
        subject: policy.dependencyReviewWorkflow,
        path: policy.dependencyReviewWorkflow,
        message: "Declared dependency-review workflow does not run the pinned official action."
      })
    );
  }
  if (!sbomFound) {
    diagnostics.push(
      diagnostic({
        rule: REPOSITORY_SECURITY_RULES.sbomMissing,
        subject: policy.sbomWorkflow,
        path: policy.sbomWorkflow,
        message: "Declared SBOM workflow does not run the pinned Anchore action."
      })
    );
  }
  for (const privileged of policy.privilegedJobs) {
    const key = `${privileged.workflowPath}:${privileged.jobId}`;
    if (!seenPrivilegedJobs.has(key)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.stalePrivilegedJob,
          subject: key,
          path: privileged.workflowPath,
          message: "Privileged-job declaration has no matching workflow job."
        })
      );
    }
  }
  for (const packageEvidence of evidence.packages) {
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
  return diagnostics;
}

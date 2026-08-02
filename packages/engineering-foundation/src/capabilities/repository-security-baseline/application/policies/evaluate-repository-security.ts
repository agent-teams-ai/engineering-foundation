import type { DiagnosticSeverity, FoundationDiagnostic } from "../../../../check-contract.js";
import type {
  PrivilegedJobPolicy,
  RepositorySecurityEvidence,
  RepositorySecurityPolicy,
  RepositorySecurityToolEvidence,
  SecurityToolName,
  ToolEvidenceRollout,
  WorkflowJobEvidence,
  WorkflowPermission
} from "../model/repository-security.js";
import {
  configuredRepositorySecurityTools,
  flattenAllowedWorkflowUses,
  isSafeLocalWorkflowUse,
  isPinnedExternalWorkflowUse
} from "../model/repository-security.js";
import {
  REPOSITORY_SECURITY_RULES,
  type RepositorySecurityRuleMetadata
} from "../rules.js";

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
  readonly severity?: DiagnosticSeverity;
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.severity ?? input.rule.severity,
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
  if (isSafeLocalWorkflowUse(action)) {
    return true;
  }
  return isPinnedExternalWorkflowUse(action);
}

function severityForRollout(rollout: ToolEvidenceRollout): DiagnosticSeverity {
  return rollout === "blocking" ? "error" : "warning";
}

function jobMatchesToolRollout(job: WorkflowJobEvidence, rollout: ToolEvidenceRollout): boolean {
  return !job.conditional && (rollout === "blocking" ? !job.nonBlocking : job.nonBlocking);
}

function jobInvokes(job: WorkflowJobEvidence, invocationUse: string): boolean {
  return job.uses === invocationUse || job.steps.some((step) => step.uses === invocationUse);
}

function evaluateToolEvidence(
  policy: RepositorySecurityPolicy,
  evidence: RepositorySecurityEvidence,
  diagnostics: FoundationDiagnostic[]
): void {
  const observed = new Map<SecurityToolName, RepositorySecurityToolEvidence>(
    evidence.toolEvidence.map((entry) => [entry.tool, entry])
  );
  for (const expected of configuredRepositorySecurityTools(policy.toolEvidence)) {
    const observedEvidence = observed.get(expected.tool);
    const severity = severityForRollout(expected.policy.rollout);
    const workflow = evidence.workflows.find(
      (candidate) => candidate.path === expected.policy.workflowPath
    );
    const job = workflow?.jobs.find((candidate) => candidate.id === expected.policy.jobId);
    if (job === undefined) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.toolEvidenceJobMissing,
          severity,
          subject: `${expected.policy.workflowPath}:${expected.policy.jobId}`,
          path: expected.policy.workflowPath,
          message: `Declared ${expected.tool} external gate job is unavailable.`,
          evidence: [{ kind: "tool", value: expected.tool }]
        })
      );
    } else if (!jobMatchesToolRollout(job, expected.policy.rollout)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.toolEvidenceRolloutMismatch,
          severity,
          subject: `${expected.policy.workflowPath}:${expected.policy.jobId}`,
          path: expected.policy.workflowPath,
          message: `Declared ${expected.tool} external gate job does not match ${expected.policy.rollout} rollout.`,
          evidence: [{ kind: "tool", value: expected.tool }]
        })
      );
    } else if (!jobInvokes(job, expected.policy.invocationUse)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.toolEvidenceInvocationMissing,
          severity,
          subject: `${expected.policy.workflowPath}:${expected.policy.jobId}`,
          path: expected.policy.workflowPath,
          message: `Declared ${expected.tool} external gate job does not invoke its reviewed immutable runner.`,
          evidence: [{ kind: "invocation-use", value: expected.policy.invocationUse }]
        })
      );
    }
    if (observedEvidence === undefined || observedEvidence.kind === "missing") {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.toolEvidenceMissing,
          severity,
          subject: expected.tool,
          path: expected.policy.evidencePath,
          message: `Required ${expected.tool} ${observedEvidence?.kind === "missing" ? observedEvidence.missing : "evidence"} is unavailable.`,
          evidence: [
            { kind: "evidence-path", value: expected.policy.evidencePath },
            { kind: "result-path", value: expected.policy.resultPath }
          ]
        })
      );
      continue;
    }
    if (observedEvidence.toolVersion !== expected.policy.version) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.toolEvidenceVersionMismatch,
          severity,
          subject: expected.tool,
          path: expected.policy.evidencePath,
          message: `${expected.tool} evidence was produced by ${observedEvidence.toolVersion}, not declared version ${expected.policy.version}.`,
          evidence: [
            { kind: "actual-version", value: observedEvidence.toolVersion },
            { kind: "expected-version", value: expected.policy.version }
          ]
        })
      );
    }
    const staleEvidence =
      observedEvidence.configDigest !== observedEvidence.actualConfigDigest ||
      observedEvidence.workflowDigest !== observedEvidence.actualWorkflowDigest;
    if (staleEvidence) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.toolEvidenceStale,
          severity,
          subject: expected.tool,
          path: expected.policy.evidencePath,
          message: `${expected.tool} evidence does not match the current opaque tool config or workflow inputs.`,
          evidence: [
            { kind: "actual-config-digest", value: observedEvidence.actualConfigDigest },
            { kind: "actual-workflow-digest", value: observedEvidence.actualWorkflowDigest },
            { kind: "reported-config-digest", value: observedEvidence.configDigest },
            { kind: "reported-workflow-digest", value: observedEvidence.workflowDigest }
          ]
        })
      );
    }
    if (observedEvidence.resultDigest !== observedEvidence.actualResultDigest) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.toolEvidenceResultDigestMismatch,
          severity,
          subject: expected.tool,
          path: expected.policy.resultPath,
          message: `${expected.tool} result artifact does not match its evidence digest.`,
          evidence: [
            { kind: "actual-result-digest", value: observedEvidence.actualResultDigest },
            { kind: "reported-result-digest", value: observedEvidence.resultDigest }
          ]
        })
      );
    }
    if (observedEvidence.outcome === "failed") {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.toolEvidenceFailed,
          severity,
          subject: expected.tool,
          path: expected.policy.evidencePath,
          message: `${expected.tool} evidence reports a failed tool execution.`,
          evidence: [{ kind: "result-digest", value: observedEvidence.resultDigest }]
        })
      );
    }
  }
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
      for (const step of job.steps) {
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
  const flattenedAllowedUses = flattenAllowedWorkflowUses(policy.allowedUses ?? []);
  const directAllowedUses = new Set(
    flattenedAllowedUses.filter(({ direct }) => direct).map(({ uses }) => uses)
  );
  const allAllowedUses = new Set(flattenedAllowedUses.map(({ uses }) => uses));
  const observedDirectUses = new Set<string>();
  for (const use of evidence.workflowUses) {
    if (!actionPinned(use.uses)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.actionNotPinned,
          subject: use.subject,
          path: use.path,
          message: `Workflow use is not pinned to immutable evidence: ${use.uses}.`,
          evidence: [{ kind: "use", value: use.uses }]
        })
      );
      continue;
    }
    if (!isPinnedExternalWorkflowUse(use.uses) || policy.allowedUses === undefined) {
      continue;
    }
    observedDirectUses.add(use.uses);
    if (!allAllowedUses.has(use.uses)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.actionNotAllowlisted,
          subject: use.subject,
          path: use.path,
          message: `Pinned external workflow use is not declared in allowedUses: ${use.uses}.`,
          evidence: [{ kind: "use", value: use.uses }]
        })
      );
    } else if (!directAllowedUses.has(use.uses)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.actionAllowlistScopeMismatch,
          subject: use.subject,
          path: use.path,
          message: `Direct repository use is declared only as transitive: ${use.uses}.`,
          evidence: [{ kind: "use", value: use.uses }]
        })
      );
    }
  }
  for (const allowedUse of directAllowedUses) {
    if (!observedDirectUses.has(allowedUse)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.staleAllowedUse,
          subject: allowedUse,
          path: policy.workflowDirectory,
          message: `Direct allowedUses entry is not referenced by discovered local workflow sources: ${allowedUse}.`,
          evidence: [{ kind: "use", value: allowedUse }]
        })
      );
    }
  }
  evaluateToolEvidence(policy, evidence, diagnostics);
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

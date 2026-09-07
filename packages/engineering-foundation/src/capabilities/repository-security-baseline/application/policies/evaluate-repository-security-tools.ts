import type { DiagnosticSeverity, FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type {
  RepositorySecurityEvidence,
  RepositorySecurityPolicy,
  RepositorySecurityToolEvidence,
  SecurityToolName,
  ToolEvidenceRollout,
  WorkflowJobEvidence
} from "../model/repository-security.js";
import { configuredRepositorySecurityTools } from "../model/repository-security.js";
import { REPOSITORY_SECURITY_RULES } from "../rules.js";
import { repositorySecurityDiagnostic as diagnostic } from "./repository-security-diagnostic.js";

function severityForRollout(rollout: ToolEvidenceRollout): DiagnosticSeverity {
  return rollout === "blocking" ? "error" : "warning";
}

function jobMatchesToolRollout(job: WorkflowJobEvidence, rollout: ToolEvidenceRollout): boolean {
  return !job.conditional && (rollout === "blocking" ? !job.nonBlocking : job.nonBlocking);
}

function workflowMatchesToolRollout(
  workflow: RepositorySecurityEvidence["workflows"][number],
  rollout: ToolEvidenceRollout
): boolean {
  return rollout !== "blocking" || workflow.pullRequestCodeChangesCovered;
}

function jobInvokes(
  job: WorkflowJobEvidence,
  invocationUse: string,
  rollout: ToolEvidenceRollout
): boolean {
  if (job.uses === invocationUse) {
    return true;
  }
  return job.steps.some(
    (step) =>
      step.uses === invocationUse &&
      !step.conditional &&
      (rollout !== "blocking" || !step.nonBlocking)
  );
}

function evaluateToolBinding(input: {
  readonly diagnostics: FoundationDiagnostic[];
  readonly evidence: RepositorySecurityEvidence;
  readonly expected: ReturnType<typeof configuredRepositorySecurityTools>[number];
  readonly observedEvidence?: RepositorySecurityToolEvidence;
}): void {
  const { diagnostics, evidence, expected, observedEvidence } = input;
  const severity = severityForRollout(expected.policy.rollout);
  const workflow = evidence.workflows.find(
    (candidate) => candidate.path === expected.policy.workflowPath
  );
  const job = workflow?.jobs.find((candidate) => candidate.id === expected.policy.jobId);
  if (workflow === undefined || job === undefined) {
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
  } else if (
    !workflowMatchesToolRollout(workflow, expected.policy.rollout) ||
    !jobMatchesToolRollout(job, expected.policy.rollout)
  ) {
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
  } else if (!jobInvokes(job, expected.policy.invocationUse, expected.policy.rollout)) {
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
    return;
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
  if (
    observedEvidence.configDigest !== observedEvidence.actualConfigDigest ||
    observedEvidence.workflowDigest !== observedEvidence.actualWorkflowDigest
  ) {
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

export function evaluateRepositorySecurityTools(
  policy: RepositorySecurityPolicy,
  evidence: RepositorySecurityEvidence,
  diagnostics: FoundationDiagnostic[]
): void {
  const observed = new Map<SecurityToolName, RepositorySecurityToolEvidence>(
    evidence.toolEvidence.map((entry) => [entry.tool, entry])
  );
  for (const expected of configuredRepositorySecurityTools(policy.toolEvidence)) {
    const observedEvidence = observed.get(expected.tool);
    evaluateToolBinding({
      diagnostics,
      evidence,
      expected,
      ...(observedEvidence === undefined ? {} : { observedEvidence })
    });
  }
}

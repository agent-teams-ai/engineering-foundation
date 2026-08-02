import type { DiagnosticSeverity } from "../../../check-contract.js";

export interface RepositorySecurityRuleMetadata {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly rationale: string;
  readonly remediation: string;
  readonly documentation: string;
  readonly requiresArchitectureReview: boolean;
}

function rule(
  suffix: string,
  rationale: string,
  remediation: string
): RepositorySecurityRuleMetadata {
  return Object.freeze({
    id: `repository.security-baseline.${suffix}`,
    severity: "error",
    rationale,
    remediation,
    documentation: "docs/security/repository-security-baseline.md",
    requiresArchitectureReview: false
  });
}

export const REPOSITORY_SECURITY_RULES = Object.freeze({
  actionNotPinned: rule(
    "action-not-pinned",
    "Mutable action references can change without repository review.",
    "Pin external actions to a full 40-character commit SHA."
  ),
  actionNotAllowlisted: rule(
    "action-not-allowlisted",
    "A pinned reference is not necessarily a trusted reference.",
    "Add the exact immutable external use to allowedUses after reviewing its owner, revision, and purpose."
  ),
  actionAllowlistScopeMismatch: rule(
    "action-allowlist-scope-mismatch",
    "A direct repository dependency is declared only as a transitive dependency of another use.",
    "Move the reference to allowedUses or remove the direct repository invocation."
  ),
  dependencyReviewMissing: rule(
    "dependency-review-missing",
    "Dependency changes need a pull-request vulnerability gate.",
    "Run the pinned actions/dependency-review-action from the declared workflow."
  ),
  dangerousTrigger: rule(
    "dangerous-trigger",
    "pull_request_target executes privileged base-branch code around untrusted pull-request data.",
    "Use pull_request or introduce a separately reviewed privileged workflow design."
  ),
  eventInterpolationInRun: rule(
    "event-interpolation-in-run",
    "Direct event-data interpolation into a shell command enables command injection.",
    "Pass event data through a quoted environment variable instead of interpolating it in run."
  ),
  packageFilesUnsafe: rule(
    "package-files-unsafe",
    "A broad npm files declaration can publish source, tests, local state, or credentials.",
    "Use a narrow explicit files allowlist without root, parent, recursive, source, test, or secret paths."
  ),
  packageProvenanceMissing: rule(
    "package-provenance-missing",
    "Published packages need verifiable build provenance.",
    "Set publishConfig.provenance to true in the publishable package manifest."
  ),
  permissionsInvalid: rule(
    "permissions-invalid",
    "Workflow token permissions must default to an explicit read-only map.",
    "Declare root permissions as an object containing only read or none values."
  ),
  sbomMissing: rule(
    "sbom-missing",
    "The dependency inventory must be reproducibly exported for each reviewed revision.",
    "Run a pinned anchore/sbom-action from the declared SBOM workflow."
  ),
  privilegedJobMismatch: rule(
    "privileged-job-mismatch",
    "Write-capable jobs need an exact reviewed permission declaration.",
    "Declare the job in privilegedJobs with the exact permission map, or remove write access."
  ),
  stalePrivilegedJob: rule(
    "stale-privileged-job",
    "A stale privilege declaration can hide workflow ownership drift.",
    "Remove the declaration or restore the exact governed workflow job."
  ),
  staleAllowedUse: rule(
    "stale-allowed-use",
    "An unused trust declaration can conceal action ownership drift.",
    "Remove the unused allowedUses entry or restore the reviewed workflow reference."
  ),
  toolEvidenceFailed: rule(
    "tool-evidence-failed",
    "A required external security tool reported a failed result.",
    "Fix the tool findings and publish fresh evidence with a passed outcome."
  ),
  toolEvidenceJobMissing: rule(
    "tool-evidence-job-missing",
    "The declared external security tool gate has no matching workflow job.",
    "Declare an existing workflow path and job ID that runs the external tool gate."
  ),
  toolEvidenceInvocationMissing: rule(
    "tool-evidence-invocation-missing",
    "The declared external tool job does not invoke its reviewed immutable runner.",
    "Declare the exact pinned invocation in the tool policy and use it from the governed job."
  ),
  toolEvidenceMissing: rule(
    "tool-evidence-missing",
    "Required external security evidence is unavailable.",
    "Run the declared tool and publish its evidence envelope and opaque result artifact."
  ),
  toolEvidenceResultDigestMismatch: rule(
    "tool-evidence-result-digest-mismatch",
    "The result artifact no longer matches the reviewed evidence envelope.",
    "Regenerate the evidence envelope and result artifact together from one tool execution."
  ),
  toolEvidenceRolloutMismatch: rule(
    "tool-evidence-rollout-mismatch",
    "The declared external tool job does not enforce the configured blocking or advisory rollout.",
    "Use an unconditional blocking job, or an unconditional continue-on-error advisory job, as declared."
  ),
  toolEvidenceStale: rule(
    "tool-evidence-stale",
    "Tool evidence does not describe the current workflow or tool configuration input.",
    "Rerun the declared tool against the current inputs and publish fresh evidence."
  ),
  toolEvidenceVersionMismatch: rule(
    "tool-evidence-version-mismatch",
    "Tool evidence was produced by a version different from the declared pinned version.",
    "Run the declared exact tool version and publish fresh evidence."
  )
});

export const REPOSITORY_SECURITY_RULES_BY_ID: ReadonlyMap<
  string,
  RepositorySecurityRuleMetadata
> = new Map(
  Object.values(REPOSITORY_SECURITY_RULES).map((metadata) => [metadata.id, metadata])
);

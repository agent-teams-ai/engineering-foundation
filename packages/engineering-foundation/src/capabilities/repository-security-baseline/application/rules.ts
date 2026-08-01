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
  )
});

export const REPOSITORY_SECURITY_RULES_BY_ID: ReadonlyMap<
  string,
  RepositorySecurityRuleMetadata
> = new Map(
  Object.values(REPOSITORY_SECURITY_RULES).map((metadata) => [metadata.id, metadata])
);

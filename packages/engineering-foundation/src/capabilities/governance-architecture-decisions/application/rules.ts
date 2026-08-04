import type { DiagnosticSeverity } from "../../../check-contract.js";

export interface ArchitectureDecisionGovernanceRuleMetadata {
  readonly documentation: string;
  readonly id: string;
  readonly rationale: string;
  readonly remediation: string;
  readonly requiresArchitectureReview: boolean;
  readonly severity: DiagnosticSeverity;
}

function rule(
  suffix: string,
  rationale: string,
  remediation: string,
  requiresArchitectureReview = false
): ArchitectureDecisionGovernanceRuleMetadata {
  return Object.freeze({
    documentation: "docs/architecture/executable-capabilities.md#governancearchitecture-decisions",
    id: `governance.architecture-decisions.${suffix}`,
    rationale,
    remediation,
    requiresArchitectureReview,
    severity: "error"
  });
}

export const ARCHITECTURE_DECISION_GOVERNANCE_RULES = Object.freeze({
  acceptedBaselineInvalid: rule(
    "accepted-baseline-invalid",
    "An immutable decision baseline must be complete and structurally verifiable.",
    "Restore a valid baseline generated from accepted architecture decisions."
  ),
  acceptedBaselineMissing: rule(
    "accepted-baseline-missing",
    "Accepted decisions must be present in the immutable baseline before they can be trusted as stable governance evidence.",
    "Promote the accepted decision into the immutable baseline through the reviewed release workflow.",
    true
  ),
  acceptedBaselineUnavailable: rule(
    "accepted-baseline-unavailable",
    "Accepted decision immutability cannot be checked without a safe baseline artifact.",
    "Restore the configured baseline as a regular repository file."
  ),
  acceptedDecisionMissing: rule(
    "accepted-decision-missing",
    "An immutable baseline entry must continue to identify an accepted or superseded decision document.",
    "Restore the decision document or perform an explicitly reviewed baseline migration.",
    true
  ),
  acceptedDecisionMutated: rule(
    "accepted-decision-mutated",
    "Accepted decision content is immutable apart from lifecycle status and superseded_by metadata.",
    "Create a successor ADR instead of editing the accepted decision."
  ),
  baselinePathMismatch: rule(
    "baseline-path-mismatch",
    "A baseline path is part of the stable identity of an accepted decision.",
    "Restore the original filename or perform an explicitly reviewed baseline migration.",
    true
  ),
  duplicateId: rule(
    "duplicate-id",
    "Architecture decision identifiers must be globally unique within governed ADR roots.",
    "Assign a new monotonic ADR identifier to one document."
  ),
  filenameMismatch: rule(
    "filename-mismatch",
    "ADR filename numbering must agree with the document identity.",
    "Use NNNN-kebab-case.md with an ID of ADR-NNNN."
  ),
  frontmatterInvalid: rule(
    "frontmatter-invalid",
    "ADR lifecycle metadata must be structured and unambiguous.",
    "Add valid YAML frontmatter with id and status fields."
  ),
  headingMismatch: rule(
    "heading-mismatch",
    "An ADR title must expose the same identity as its metadata and filename.",
    "Use exactly one level-one heading in the form ADR-NNNN: concise title."
  ),
  indexMembership: rule(
    "index-membership",
    "The ADR index must present each decision under exactly its lifecycle section.",
    "List the ADR once under the configured section for its current status."
  ),
  indexMissing: rule(
    "index-missing",
    "A configured ADR index is required to make lifecycle evidence discoverable.",
    "Create the configured index document as a regular Markdown file."
  ),
  lifecycleInvalid: rule(
    "lifecycle-invalid",
    "ADR status and lifecycle references must describe one coherent decision history.",
    "Correct status, supersedes, and superseded_by metadata."
  ),
  sourceUnavailable: rule(
    "source-unavailable",
    "ADR governance cannot make a complete decision inventory when sources are unavailable.",
    "Restore a readable regular Markdown source under the governed ADR roots."
  ),
  supersedesCycle: rule(
    "supersedes-cycle",
    "Supersession must form an acyclic historical relation.",
    "Create a forward successor relation without referring back to a predecessor."
  ),
  supersedesMismatch: rule(
    "supersedes-mismatch",
    "Supersession references must be bidirectional so historical navigation is deterministic.",
    "Update both predecessor and successor metadata to reference each other."
  ),
  symbolicLink: rule(
    "symbolic-link",
    "ADR evidence must not traverse symbolic links because they can bypass repository containment.",
    "Replace the symbolic link with a regular repository file or directory.",
    true
  )
});

export const ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID: ReadonlyMap<
  string,
  ArchitectureDecisionGovernanceRuleMetadata
> = new Map(
  Object.values(ARCHITECTURE_DECISION_GOVERNANCE_RULES).map((metadata) => [
    metadata.id,
    metadata
  ])
);

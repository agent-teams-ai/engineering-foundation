import type { DiagnosticSeverity } from "../../../check-contract.js";

export interface PublicApiCompatibilityRuleMetadata {
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
  remediation: string,
  requiresArchitectureReview = false
): PublicApiCompatibilityRuleMetadata {
  return Object.freeze({
    id: `package.public-api-compatibility.${suffix}`,
    severity: "error",
    rationale,
    remediation,
    documentation: "docs/architecture/public-api-compatibility.md",
    requiresArchitectureReview
  });
}

export const PUBLIC_API_COMPATIBILITY_RULES = Object.freeze({
  baselineToolMismatch: rule(
    "baseline-tool-mismatch",
    "API surfaces produced by different extractor versions are not directly comparable evidence.",
    "Regenerate the released baseline only through the release workflow after reviewing the tool upgrade.",
    true
  ),
  baselineVersionMismatch: rule(
    "baseline-version-mismatch",
    "The released API baseline must identify the currently versioned package release.",
    "Promote the current surface during the version release workflow."
  ),
  breakingChangeNotApproved: rule(
    "breaking-change-not-approved",
    "A breaking public API change needs an explicit accepted architecture decision.",
    "Approve the reported fingerprint in an ADR-backed breaking-change entry.",
    true
  ),
  decisionNotAccepted: rule(
    "decision-not-accepted",
    "A breaking-change approval is authoritative only when its referenced decision is accepted.",
    "Accept the referenced ADR or remove the breaking API change.",
    true
  ),
  insufficientChangeset: rule(
    "insufficient-changeset",
    "A public API change must request a release bump compatible with its risk.",
    "Raise the package Changeset to the required minor or major bump."
  ),
  missingChangeset: rule(
    "missing-changeset",
    "Public API changes must be visible in release intent before merge.",
    "Add a Changeset for the affected package."
  )
});

export const PUBLIC_API_COMPATIBILITY_RULES_BY_ID: ReadonlyMap<
  string,
  PublicApiCompatibilityRuleMetadata
> = new Map(
  Object.values(PUBLIC_API_COMPATIBILITY_RULES).map((metadata) => [metadata.id, metadata])
);

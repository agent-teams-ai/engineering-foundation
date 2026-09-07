import type { DiagnosticSeverity } from "../../../features/validation-reporting/api.js";
import { createUniqueRegistry } from "../../../features/validation-reporting/api.js";

export interface SuppressionGovernanceRuleMetadata {
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
): SuppressionGovernanceRuleMetadata {
  return Object.freeze({
    id: `quality.suppression-governance.${suffix}`,
    severity: "error",
    rationale,
    remediation,
    documentation: "docs/architecture/suppression-governance.md",
    requiresArchitectureReview
  });
}

export const SUPPRESSION_GOVERNANCE_RULES = Object.freeze({
  broadSuppression: rule(
    "broad-suppression",
    "File and region suppressions hide unrelated future diagnostics.",
    "Replace the directive with an exact line-scoped suppression and waiver."
  ),
  excessiveLifetime: rule(
    "excessive-waiver-lifetime",
    "A temporary waiver must not silently become permanent technical debt.",
    "Shorten the waiver lifetime to at most 90 calendar days."
  ),
  expiredWaiver: rule(
    "expired-waiver",
    "Expired exceptions must be removed or explicitly reconsidered.",
    "Remove the suppression or approve a new bounded waiver."
  ),
  futureWaiver: rule(
    "future-waiver",
    "A waiver cannot be created in the future relative to the build clock.",
    "Correct createdOn using the current UTC calendar date."
  ),
  legacySuppression: rule(
    "legacy-suppression",
    "ESLint compatibility directives create a second suppression vocabulary.",
    "Use an Oxlint directive and register an exact waiver."
  ),
  prohibitedTypeScriptSuppression: rule(
    "prohibited-typescript-suppression",
    "TypeScript ignore and nocheck directives can hide unrelated compiler failures.",
    "Remove the directive; use a line-scoped @ts-expect-error waiver only when necessary."
  ),
  protectedRuleSuppression: rule(
    "protected-rule-suppression",
    "Security and tenant-isolation rules are not waivable.",
    "Fix the violation or change the governing architecture through an accepted decision.",
    true
  ),
  sourceParseError: rule(
    "source-parse-error",
    "Suppression evidence is incomplete when governed source does not parse.",
    "Fix the source syntax before evaluating suppression governance."
  ),
  staleWaiver: rule(
    "stale-waiver",
    "A waiver without one exact suppression is stale or incorrectly scoped.",
    "Remove the waiver or align its path, line, directive, and rules with the source."
  ),
  unregisteredSuppression: rule(
    "unregistered-suppression",
    "Every allowed suppression needs accountable, expiring ownership.",
    "Register an exact waiver with owner, reason, expiry, and decision reference."
  ),
  unscopedSuppression: rule(
    "unscoped-suppression",
    "A suppression without explicit rule IDs can hide arbitrary diagnostics.",
    "List every suppressed rule explicitly."
  ),
  waiverMismatch: rule(
    "waiver-mismatch",
    "A waiver must describe the exact directive and exact rule set at its location.",
    "Update the waiver or suppression so their directive and rules match exactly."
  )
});

export const SUPPRESSION_GOVERNANCE_RULES_BY_ID: ReadonlyMap<
  string,
  SuppressionGovernanceRuleMetadata
> = createUniqueRegistry(
  "rule",
  Object.values(SUPPRESSION_GOVERNANCE_RULES).map((metadata) => [metadata.id, metadata])
);

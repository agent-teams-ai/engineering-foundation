import type { DiagnosticSeverity } from "../../../features/validation-reporting/api.js";
import { createUniqueRegistry } from "../../../features/validation-reporting/api.js";

export interface FindingsBaselineRuleMetadata {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly rationale: string;
  readonly remediation: string;
  readonly documentation: string;
  readonly requiresArchitectureReview: boolean;
}

function rule(suffix: string, rationale: string, remediation: string): FindingsBaselineRuleMetadata {
  return Object.freeze({
    id: `quality.findings-baseline.${suffix}`,
    severity: "error",
    rationale,
    remediation,
    documentation: "docs/architecture/findings-baseline.md",
    requiresArchitectureReview: false
  });
}

export const FINDINGS_BASELINE_RULES = Object.freeze({
  newFinding: rule(
    "new-finding",
    "A finding that is not in the baseline is new debt; the baseline only shrinks.",
    "Fix the finding. The baseline never accepts a new entry after its first creation."
  ),
  worseFinding: rule(
    "worse-finding",
    "A finding above its baseline entry (more occurrences or a larger measured value) grows existing debt.",
    "Bring the file back to its baseline count and value or below; do not raise the entry."
  ),
  staleEntry: rule(
    "stale-entry",
    "A baseline entry above the observed finding, or for a finding that vanished, hides room for new debt.",
    "Run `agent-teams-foundation baseline prune` to lower or remove the entry."
  )
});

export const FINDINGS_BASELINE_RULES_BY_ID: ReadonlyMap<string, FindingsBaselineRuleMetadata> = createUniqueRegistry(
  "rule",
  Object.values(FINDINGS_BASELINE_RULES).map((metadata) => [metadata.id, metadata])
);

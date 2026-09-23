import type { FoundationDiagnostic, RuleExplanation } from "../../validation-reporting/api.js";

export const QUALITY_COVERAGE_ID = "quality.source-coverage";

const RULES = {
  "source-package": ["Every package in the production census must be classified independently of workspace and lint filters.", "Map the package in the existing consumer topology and source authority."],
  "source-classification": ["Every production source has exactly one consumer-owned classification.", "Classify this source in the existing source authority."],
  "native-route": ["Every native production source requires one reachable consumer-owned gate.", "Map its existing source boundary to a native gate script required by the full entrypoint; qualify native execution in the consumer."],
  "source-language": ["The qualified runner supports TypeScript source and JavaScript modules.", "Qualify the new language before activating this source."],
  "source-empty": ["An active typed coverage claim requires TypeScript production source.", "Restore the applicable production source or remove the unsupported activation."],
  "suppression-coverage": ["Production source must remain under suppression governance.", "Include this source in the existing suppression policy."],
  "protected-setting": ["Mandatory lint protection cannot be weakened by configuration.", "Restore the protected setting; preserve stronger consumer rules."],
  "required-route": ["Required gates must execute the declared coverage mode.", "Restore the literal required script route to quality check."],
  "selection-mismatch": ["Oxlint selection must equal the lint-applicable portion of the independently discovered production universe.", "Remove exclusions or repair source classification so production and selected files agree."],
  "type-context": ["Every production file needs a real compiler project context.", "Restore production tsconfig inclusion and build required declarations."],
  "lint-violation": ["The consumer-local typed linter reported a source violation.", "Fix the reported tool rule at the indicated source location."],
  "explicit-unknown": ["An explicit unknown assertion chain needs an exact, source-bound bridge admission.", "Remove the chain or admit this exact bridge with a rationale and rejecting evidence in the consumer profile."]
} satisfies Record<string, readonly [string, string]>;

export type QualityCoverageRule = keyof typeof RULES;

export const QUALITY_COVERAGE_RULES_BY_ID: ReadonlyMap<string, RuleExplanation> = new Map(
  Object.entries(RULES).map(([suffix, [rationale, remediation]]) => {
    const id = `${QUALITY_COVERAGE_ID}.${suffix}`;
    return [id, { id, rationale, remediation, documentation: "docs/reference/quality-source-coverage.md" }];
  })
);

export function qualityDiagnostic(
  rule: QualityCoverageRule,
  path: string,
  subject: string,
  expected: string,
  actual: string
): FoundationDiagnostic {
  const [message, remediation] = RULES[rule];
  return {
    ruleId: `${QUALITY_COVERAGE_ID}.${rule}`,
    severity: "error",
    subject,
    message,
    location: { path },
    relatedLocations: [],
    evidence: [{ kind: "expected", value: expected }, { kind: "actual", value: actual }],
    remediation,
    requiresArchitectureReview: false
  };
}

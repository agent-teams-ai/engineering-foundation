import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type { MarkdownObservationIssue } from "../../../../documentation-observation/application/model/markdown-document.js";
import {
  ARCHITECTURE_DECISION_GOVERNANCE_RULES,
  type ArchitectureDecisionGovernanceRuleMetadata
} from "../rules.js";

interface ArchitectureDecisionDiagnosticInput {
  readonly column?: number;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
  readonly line?: number;
  readonly message: string;
  readonly path: string;
  readonly relatedPath?: string;
  readonly rule: ArchitectureDecisionGovernanceRuleMetadata;
  readonly subject: string;
}

export function architectureDecisionDiagnostic(
  input: ArchitectureDecisionDiagnosticInput
): FoundationDiagnostic {
  return {
    evidence: input.evidence ?? [],
    location: {
      path: input.path,
      ...(input.line === undefined
        ? {}
        : {
            start: {
              column: input.column ?? 1,
              line: input.line
            }
          })
    },
    message: input.message,
    relatedLocations:
      input.relatedPath === undefined ? [] : [{ path: input.relatedPath }],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview,
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject
  };
}

export function architectureDecisionIssueDiagnostic(
  issue: MarkdownObservationIssue
): FoundationDiagnostic {
  const rule =
    issue.kind === "symbolic-link"
      ? ARCHITECTURE_DECISION_GOVERNANCE_RULES.symbolicLink
      : ARCHITECTURE_DECISION_GOVERNANCE_RULES.sourceUnavailable;
  return architectureDecisionDiagnostic({
    evidence: [{ kind: "observation-issue", value: issue.kind }],
    message: issue.message,
    path: issue.repositoryPath,
    rule,
    subject: issue.repositoryPath
  });
}

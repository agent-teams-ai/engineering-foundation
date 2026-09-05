import type { DiagnosticSeverity, FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type { RepositorySecurityRuleMetadata } from "../rules.js";

export function repositorySecurityDiagnostic(input: {
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
  readonly message: string;
  readonly path: string;
  readonly rule: RepositorySecurityRuleMetadata;
  readonly severity?: DiagnosticSeverity;
  readonly subject: string;
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

import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type {
  RepositorySecurityEvidence,
  RepositorySecurityPolicy
} from "../model/repository-security.js";
import {
  flattenAllowedWorkflowUses,
  isPinnedExternalWorkflowUse,
  isSafeLocalWorkflowUse
} from "../model/repository-security.js";
import { REPOSITORY_SECURITY_RULES } from "../rules.js";
import { repositorySecurityDiagnostic as diagnostic } from "./repository-security-diagnostic.js";

function usePinned(use: string): boolean {
  return isSafeLocalWorkflowUse(use) || isPinnedExternalWorkflowUse(use);
}

export function evaluateRepositoryWorkflowUses(
  policy: RepositorySecurityPolicy,
  evidence: RepositorySecurityEvidence,
  diagnostics: FoundationDiagnostic[]
): void {
  const flattenedAllowedUses = flattenAllowedWorkflowUses(policy.allowedUses);
  const directAllowedUses = new Set(
    flattenedAllowedUses.filter(({ direct }) => direct).map(({ uses }) => uses)
  );
  const allAllowedUses = new Set(flattenedAllowedUses.map(({ uses }) => uses));
  const observedDirectUses = new Set<string>();
  for (const use of evidence.workflowUses) {
    if (!usePinned(use.uses)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.actionNotPinned,
          subject: use.subject,
          path: use.path,
          message: `Workflow use is not pinned to immutable evidence: ${use.uses}.`,
          evidence: [{ kind: "use", value: use.uses }]
        })
      );
      continue;
    }
    if (!isPinnedExternalWorkflowUse(use.uses)) {
      continue;
    }
    observedDirectUses.add(use.uses);
    const allowlisted = allAllowedUses.has(use.uses);
    const direct = directAllowedUses.has(use.uses);
    if (!allowlisted || !direct) {
      diagnostics.push(
        diagnostic({
          rule: allowlisted
            ? REPOSITORY_SECURITY_RULES.actionAllowlistScopeMismatch
            : REPOSITORY_SECURITY_RULES.actionNotAllowlisted,
          subject: use.subject,
          path: use.path,
          message: allowlisted
            ? `Direct repository use is declared only as transitive: ${use.uses}.`
            : `Pinned external workflow use is not declared in allowedUses: ${use.uses}.`,
          evidence: [{ kind: "use", value: use.uses }]
        })
      );
    }
  }
  for (const allowedUse of directAllowedUses) {
    if (!observedDirectUses.has(allowedUse)) {
      diagnostics.push(
        diagnostic({
          rule: REPOSITORY_SECURITY_RULES.staleAllowedUse,
          subject: allowedUse,
          path: policy.workflowDirectory,
          message: `Direct allowedUses entry is not referenced by discovered local workflow sources: ${allowedUse}.`,
          evidence: [{ kind: "use", value: allowedUse }]
        })
      );
    }
  }
}

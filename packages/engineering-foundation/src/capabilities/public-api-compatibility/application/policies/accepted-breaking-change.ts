import type { ApprovedBreakingChange } from "../model/public-api.js";
import type { AcceptedDecisionEvidence } from "../ports/accepted-decision-evidence.js";

export function isApprovedBreakingChangeAccepted(
  approval: ApprovedBreakingChange,
  evidence: AcceptedDecisionEvidence
): boolean {
  return evidence.acceptedDecisionIds.includes(approval.decisionId);
}

import {
  isLegacyApprovedBreakingChange,
  type ApprovedBreakingChange
} from "../model/public-api.js";
import type { AcceptedDecisionEvidence } from "../ports/accepted-decision-evidence.js";

/**
 * Schema v1 and v2 have different approval references, but both must resolve
 * through the same immutable governance evidence before authorizing a break.
 */
export function isApprovedBreakingChangeAccepted(
  approval: ApprovedBreakingChange,
  evidence: AcceptedDecisionEvidence
): boolean {
  return isLegacyApprovedBreakingChange(approval)
    ? evidence.acceptedDecisionPaths.includes(approval.decisionPath)
    : evidence.acceptedDecisionIds.includes(approval.decisionId);
}

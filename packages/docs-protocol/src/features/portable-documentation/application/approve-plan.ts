import type { DocsCommandOutcome, DocsDiagnostic, DocsNewRequest } from "./model.js";
import type { DocsNewResultV2 } from "./model-v2.js";
import { inspectPlanApproval } from "../domain/plan-approval.js";

export function documentPlanApprovalFailure(
  request: Pick<DocsNewRequest, "apply" | "expectedPlanDigest">,
  actualPlanDigest?: string
): { readonly outcome: DocsCommandOutcome; readonly result: DocsNewResultV2; readonly diagnostics: readonly DocsDiagnostic[] } | undefined {
  const approval = inspectPlanApproval(request.expectedPlanDigest, actualPlanDigest);
  if (approval.state === "malformed" || (!request.apply && request.expectedPlanDigest !== undefined)) {
    return {
      outcome: "invalid-input", result: Object.freeze({}), diagnostics: [{
        ruleId: "docs.new.expected-plan-digest-invalid", severity: "error", phase: "input",
        subject: "expectedPlanDigest", message: "Expected Plan digest must be sha256 followed by 64 lowercase hexadecimal digits and supplied only for Apply."
      }]
    };
  }
  if (approval.state === "stale") {
    return {
      outcome: "authority-stale",
      result: Object.freeze({ kind: "new", reservation: "none", writeState: "blocked", reason: "authority-stale" } as const),
      diagnostics: [{
        ruleId: "docs.new.plan-digest-stale", severity: "error", phase: "authority",
        subject: "expectedPlanDigest", message: "The compiled Document Plan differs from the reviewed preview; review a fresh preview."
      }]
    };
  }
  return undefined;
}

import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";
import { claimedArtifactCoordinate } from "./claimed-artifact-coordinate.js";

/** Schema5 is opaque historical evidence, never a split-package recovery lease. */
export function inspectKnownFileTransactionStatus(
  value: Record<string, unknown>
): InternalFoundationTransactionStatus {
  return {
    state: "manual-recovery-required",
    reason: "recovery-handler-unavailable",
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message: `Untrusted Foundation schema5 evidence was preserved. Claimed @agent-teams/engineering-foundation coordinate: ${claimedArtifactCoordinate(value["foundation"])}. Only the exact recorded historical Foundation artifact can validate its supported ./mutation recovery route externally; this package cannot authorize recovery.`
    }]
  };
}

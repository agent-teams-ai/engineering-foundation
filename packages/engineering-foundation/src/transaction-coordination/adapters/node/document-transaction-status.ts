import { claimedArtifactCoordinate } from "./claimed-artifact-coordinate.js";
import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Passive observation of both document owners; neither is a Foundation lease. */
export function inspectDocumentTransactionStatus(
  value: Record<string, unknown>
): InternalFoundationTransactionStatus {
  const handler = record(value["recoveryHandler"]);
  const compiler = record(record(record(value["journal"])["plan"])["compiler"]);
  const coordinate = claimedArtifactCoordinate(value["foundation"]);
  const owner = compiler["id"];
  const guidance = owner === "@agent-teams/engineering-foundation" &&
    handler["id"] === "foundation.document-authoring"
    ? `Claimed @agent-teams/engineering-foundation coordinate: ${coordinate}. Use only the exact recorded historical Foundation artifact's supported ./document-authoring recoverDocumentationTransaction boundary externally.`
    : owner === "@agent-teams/document-authoring" && handler["id"] === "document-authoring"
      ? `Claimed @agent-teams/document-authoring coordinate: ${coordinate}. Use Document Authoring's own public inspectDocumentTransactionV2/recoverDocumentationTransactionV2 boundary to validate its exact owner and kernel artifacts.`
      : "The compiler/handler owner claims are mixed, missing, or unknown; manual investigation is required.";
  return {
    state: "manual-recovery-required",
    reason: "recovery-handler-unavailable",
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message: `Untrusted document schema${String(value["schemaVersion"])} evidence was preserved. ${guidance} This Foundation observer does not validate the journal or authorize recovery.`
    }]
  };
}

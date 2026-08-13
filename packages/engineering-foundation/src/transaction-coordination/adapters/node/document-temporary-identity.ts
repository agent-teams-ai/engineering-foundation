import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyNodeTemporaryIdentity(
  value: unknown
): "invalid" | "unverifiable" | "verifiable" {
  if (!isRecord(value)) {
    return "invalid";
  }
  const decimal = /^(?:0|[1-9][0-9]{0,31})$/u;
  if (value["adapter"] !== "node-filesystem" || value["version"] !== 1 ||
    typeof value["dev"] !== "string" || !decimal.test(value["dev"]) ||
    typeof value["ino"] !== "string" || !decimal.test(value["ino"]) ||
    typeof value["birthtimeNs"] !== "string" || !decimal.test(value["birthtimeNs"])) {
    return "invalid";
  }
  return value["dev"] === "0" || value["ino"] === "0" ||
    value["birthtimeNs"] === "0" ? "unverifiable" : "verifiable";
}

export function unverifiableDocumentTemporaryStatus(
  foundation: Record<string, unknown>,
  format: "envelope-v2" | "envelope-v3" = "envelope-v2"
): InternalFoundationTransactionStatus {
  return {
    state: "manual-recovery-required", reason: "physical-identity-unverifiable",
    operationKind: "document-authoring", format,
    foundationVersion: String(foundation["version"]),
    foundationBuildIdentity: String(foundation["buildIdentity"]),
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message: "The preserved Document transaction has an adapter-reported zero physical identity and cannot authorize automatic recovery or publication."
    }]
  };
}

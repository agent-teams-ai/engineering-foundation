import { assertSchema } from "../../../schema-catalog.js";
import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";
import { assertEnvelopeDigests } from "./legacy-envelope-digests.js";
import { assertLegacyDocumentEnvelope, isKnownLegacyDocumentEnvelope } from "./legacy-document-envelope-v2.js";
import { inspectDocumentTransactionBindings } from "./document-envelope-bindings.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function inspectLegacyDocumentTransaction(
  value: Record<string, unknown>
): Promise<InternalFoundationTransactionStatus> {
    const legacyDocumentEnvelope = isKnownLegacyDocumentEnvelope(value);
    if (legacyDocumentEnvelope) {
      assertLegacyDocumentEnvelope(value);
    } else {
      await assertSchema(
        "foundation-transaction-envelope/v2",
        value,
        "foundation-transaction-slot"
      );
      assertEnvelopeDigests(value);
    }
    const foundation = value["foundation"];
    const operationKind = value["operationKind"];
    const journal = value["journal"];
    if (
      !isRecord(foundation) ||
      typeof foundation["version"] !== "string" ||
      typeof foundation["buildIdentity"] !== "string" ||
      !isRecord(journal) ||
      !["document-authoring", "scaffolding"].includes(String(operationKind))
    ) {
      throw new Error("Foundation transaction envelope binding is invalid.");
    }
    const plan = journal["plan"];
    if (!isRecord(plan)) {
      throw new Error("Foundation transaction Plan binding is invalid.");
    }
    const compiler = plan["compiler"];
    if (
      !isRecord(compiler) ||
      compiler["version"] !== foundation["version"] ||
      (operationKind === "document-authoring" &&
        compiler["buildIdentity"] !== foundation["buildIdentity"])
    ) {
      throw new Error("Foundation transaction compiler binding is invalid.");
    }
    if (operationKind === "document-authoring") {
      const documentStatus = inspectDocumentTransactionBindings({
        foundation,
        journal,
        journalVersion: 1,
        legacyDigestSemantics: legacyDocumentEnvelope,
        plan,
        state: value["state"]
      });
      if (documentStatus !== undefined) {
        return documentStatus;
      }
    }
    return {
      state: "manual-recovery-required",
      reason: "recovery-handler-unavailable",
      operationKind: operationKind as "document-authoring" | "scaffolding",
      format: "envelope-v2",
      foundationVersion: foundation["version"],
      foundationBuildIdentity: foundation["buildIdentity"],
      diagnostics: [
        {
          code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
          message: `A verified ${String(operationKind)} envelope v2 from Foundation ${foundation["version"]} (${foundation["buildIdentity"]}) was preserved, but this release does not yet provide its recovery handler.`
        }
      ]
    };
}

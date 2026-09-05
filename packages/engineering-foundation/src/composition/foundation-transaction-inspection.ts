import { canonicalJson, type CanonicalJsonValue } from "@agent-teams/repository-mutation";
import {
  inspectCurrentScaffoldingTransaction,
  inspectLegacyScaffoldingEnvelope,
  inspectLegacyScaffoldingJournal
} from "../scaffolding/adapters/node/scaffold-transaction-status.js";
import { inspectDocumentTransactionStatus } from "../transaction-coordination/adapters/node/document-transaction-status.js";
import { inspectLegacyDocumentTransaction } from "../transaction-coordination/adapters/node/legacy-document-transaction-status.js";
import { inspectKnownFileTransactionStatus } from "../transaction-coordination/adapters/node/known-file-transaction-status.js";
import { inspectSchema6TransactionStatus } from "../transaction-coordination/adapters/node/schema6-transaction-status.js";
import type { InternalFoundationTransactionStatus } from "../transaction-coordination/application/model/internal-transaction-status.js";

/** Fixed owner selection only; consumer input cannot register a handler. */
export async function inspectFoundationTransaction(value: unknown, installed: {
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): Promise<InternalFoundationTransactionStatus> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      state: "manual-recovery-required",
      reason: "invalid-slot",
      diagnostics: [{
        code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
        message: "The Foundation transaction slot is invalid and was preserved."
      }]
    };
  }
  const record = value as Record<string, unknown>;
  const schemaVersion = typeof record["schemaVersion"] === "number"
    ? record["schemaVersion"] : Number.NaN;
  switch (schemaVersion) {
  case 1:
    return inspectLegacyScaffoldingJournal({ value: record, ...installed });
  case 2:
    return record["operationKind"] === "scaffolding"
      ? inspectLegacyScaffoldingEnvelope(record)
      : inspectLegacyDocumentTransaction(record);
  case 3:
  case 4:
    return inspectDocumentTransactionStatus(record);
  case 5:
    return inspectKnownFileTransactionStatus(record);
  case 6:
    return record["operationKind"] === "scaffolding"
      ? inspectCurrentScaffoldingTransaction({
          bytes: Buffer.from(canonicalJson(record as CanonicalJsonValue), "utf8"), ...installed
        })
      : inspectSchema6TransactionStatus(record);
  default:
    return {
      state: "manual-recovery-required",
      reason: "unsupported-schema",
      diagnostics: [{
        code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
        message: `Foundation transaction schema version ${String(schemaVersion)} is unsupported and was preserved.`
      }]
    };
  }
}

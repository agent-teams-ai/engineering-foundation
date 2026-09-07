import type { InternalFoundationTransactionStatus } from "../model/internal-transaction-status.js";
import type {
  FoundationTransactionInspection,
  FoundationTransactionInspectors,
  InstalledFoundationInspectionIdentity
} from "../ports/foundation-transaction-inspection.js";

export function createFoundationTransactionInspection(
  installed: InstalledFoundationInspectionIdentity,
  inspectors: FoundationTransactionInspectors
): FoundationTransactionInspection {
  return { inspect: (value) => inspectFoundationTransaction(value, installed, inspectors) };
}

async function inspectFoundationTransaction(
  value: unknown,
  installed: InstalledFoundationInspectionIdentity,
  inspectors: FoundationTransactionInspectors
): Promise<InternalFoundationTransactionStatus> {
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
    return inspectors.legacyScaffoldingJournal({ value: record, ...installed });
  case 2:
    return record["operationKind"] === "scaffolding"
      ? inspectors.legacyScaffoldingEnvelope(record)
      : inspectors.legacyDocument(record);
  case 3:
  case 4:
    return inspectors.document(record);
  case 5:
    return inspectors.knownFile(record);
  case 6:
    return record["operationKind"] === "scaffolding"
      ? inspectors.currentScaffolding({
          value: record, ...installed
        })
      : inspectors.schema6(record);
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

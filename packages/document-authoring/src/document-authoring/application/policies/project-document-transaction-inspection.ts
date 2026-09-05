import type { DocumentTransactionInspectionDiagnostic, DocumentTransactionInspectionV1, DocumentTransactionInspectionV2 } from "../model/document-transaction-inspection.js";
import type { DocumentTransactionEnvelope } from "../model/document-transaction.js";
function diagnostic(
  code: DocumentTransactionInspectionDiagnostic["code"], message: string
): readonly DocumentTransactionInspectionDiagnostic[] {
  return [{ code, message }];
}

export function unsafeDocumentTransactionInspection(reason: string): Extract<DocumentTransactionInspectionV2, {
  readonly state: "manual-recovery-required";
}> {
  return {
    schemaVersion: 2,
    state: "manual-recovery-required",
    reason,
    transactionKind: "corrupt",
    diagnostics: diagnostic("FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED", reason)
  };
}

export function classifyDocumentTransactionInspection(envelope: DocumentTransactionEnvelope, version: string, buildIdentity: `sha256:${string}`): DocumentTransactionInspectionV2 {
  const exact = envelope.foundation.version === version &&
    envelope.foundation.buildIdentity === buildIdentity;
  const format = envelope.schemaVersion === 4
    ? "document-authoring-envelope-v4" as const
    : "document-authoring-envelope-v3" as const;
  if (!exact) {
    const reason = `Document Authoring ${envelope.foundation.version} (${envelope.foundation.buildIdentity}) must recover this transaction before ${version} (${buildIdentity}) can mutate the repository.`;
    return {
      schemaVersion: 2,
      state: "manual-recovery-required",
      reason,
      operationKind: "document-authoring",
      transactionKind: "version-mismatch",
      format,
      foundationVersion: envelope.foundation.version,
      foundationBuildIdentity: envelope.foundation.buildIdentity,
      recovery: {
        commandId: "docs-recover",
        args: {
          exactFoundationVersion: envelope.foundation.version,
          exactFoundationBuildIdentity: envelope.foundation.buildIdentity
        }
      },
      diagnostics: diagnostic("FOUNDATION_TRANSACTION_VERSION_MISMATCH", reason)
    };
  }
  return {
    schemaVersion: 2,
    state: "recoverable",
    operationKind: "document-authoring",
    format,
    foundationVersion: version,
    foundationBuildIdentity: buildIdentity,
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: version,
      exactFoundationBuildIdentity: buildIdentity
    },
    diagnostics: diagnostic("FOUNDATION_TRANSACTION_ACTIVE", "A pending document-authoring transaction must be recovered.")
  };
}

export function projectDocumentTransactionInspectionV1(observed: DocumentTransactionInspectionV2): DocumentTransactionInspectionV1 {
  if (observed.state === "idle") {
    return { schemaVersion: 1, state: "idle", diagnostics: [] };
  }
  if (observed.state === "recoverable" && observed.format === "document-authoring-envelope-v3") {
    return { ...observed, schemaVersion: 1, format: "document-authoring-envelope-v3" };
  }
  if (observed.state === "recoverable") {
    return {
      schemaVersion: 1,
      state: "manual-recovery-required",
      reason: "Document transaction envelope v4 requires the v2 inspection contract.",
      operationKind: "document-authoring",
      transactionKind: "document",
      format: observed.format,
      foundationVersion: observed.foundationVersion,
      foundationBuildIdentity: observed.foundationBuildIdentity,
      recovery: {
        commandId: "docs-recover",
        args: {
          exactFoundationVersion: observed.recovery.exactFoundationVersion,
          exactFoundationBuildIdentity: observed.recovery.exactFoundationBuildIdentity
        }
      },
      diagnostics: observed.diagnostics
    };
  }
  return { ...observed, schemaVersion: 1 };
}

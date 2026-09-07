import type { DocumentTransactionInspectionDiagnostic, DocumentTransactionInspectionV1, DocumentTransactionInspectionV2 } from "../model/document-transaction-inspection.js";
import type { DocumentTransactionEnvelope } from "../model/document-transaction.js";
import type { DocumentCompilerIdentity } from "../model/document-planning.js";
function diagnostic(
  code: DocumentTransactionInspectionDiagnostic["code"], message: string
): readonly DocumentTransactionInspectionDiagnostic[] {
  return [{ code, message }];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : {};
}

/** Passive attribution of rejected evidence; never a historical reader or admission. */
export function untrustedDocumentEnvelopeReason(value: unknown): string {
  const envelope = record(value);
  const compiler = record(record(record(envelope["journal"])["plan"])["compiler"]);
  const handler = record(envelope["recoveryHandler"])["id"];
  if (compiler["id"] === "@agent-teams/engineering-foundation" &&
    handler === "foundation.document-authoring") {
    return "Unvalidated evidence claims @agent-teams/engineering-foundation / foundation.document-authoring. Preserve it for manual review with the exact recorded Foundation version and build artifact; current Document Authoring cannot recover it.";
  }
  if (compiler["id"] === "@agent-teams/document-authoring" && handler === "document-authoring" &&
    envelope["kernelArtifact"] === undefined) {
    return "Unvalidated @agent-teams/document-authoring candidate evidence has no recorded Mutation kernelArtifact; manual recovery is required and evidence was preserved.";
  }
  return "Transaction evidence is foreign, mixed, corrupt, or incompatible; it was preserved for manual recovery.";
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

export function hasExactDocumentRecoveryArtifacts(
  envelope: DocumentTransactionEnvelope,
  compiler: DocumentCompilerIdentity,
  kernelArtifact: DocumentTransactionEnvelope["kernelArtifact"]
): boolean {
  // Keep runtime identity checks at the port boundary, including callers from
  // JavaScript. Static literal types alone are not recovery evidence.
  const handler = record(envelope.recoveryHandler);
  const owner = record(envelope.journal.plan.compiler);
  const kernel = record(envelope.kernelArtifact);
  return handler["id"] === "document-authoring" &&
    compiler.id === owner["id"] &&
    envelope.foundation.version === compiler.version &&
    envelope.foundation.buildIdentity === compiler.buildIdentity &&
    envelope.journal.plan.compiler.version === compiler.version &&
    envelope.journal.plan.compiler.buildIdentity === compiler.buildIdentity &&
    kernel["name"] === kernelArtifact.name &&
    kernel["version"] === kernelArtifact.version &&
    kernel["buildIdentity"] === kernelArtifact.buildIdentity;
}

export function classifyDocumentTransactionInspection(
  envelope: DocumentTransactionEnvelope,
  compiler: DocumentCompilerIdentity,
  kernelArtifact: DocumentTransactionEnvelope["kernelArtifact"]
): DocumentTransactionInspectionV2 {
  const { version, buildIdentity } = compiler;
  const exact = hasExactDocumentRecoveryArtifacts(envelope, compiler, kernelArtifact);
  const format = envelope.schemaVersion === 4
    ? "document-authoring-envelope-v4" as const
    : "document-authoring-envelope-v3" as const;
  if (!exact) {
    const reason = `Exact @agent-teams/document-authoring ${envelope.foundation.version} (${envelope.foundation.buildIdentity}) and ${envelope.kernelArtifact.name} ${envelope.kernelArtifact.version} (${envelope.kernelArtifact.buildIdentity}) are required; the installed owner or kernel differs. Evidence was preserved.`;
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

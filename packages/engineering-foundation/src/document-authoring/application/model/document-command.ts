import type { DocumentReceiptOutcome } from "./document-receipt.js";

export type DocumentCommandId =
  | "docs.doctor"
  | "docs.new"
  | "docs.recover";

export type DocumentCommandOutcome =
  | "authority-stale"
  | "cancelled"
  | "conflict"
  | "execution-failure"
  | "invalid-input"
  | "recovery-required"
  | "success"
  | "violation";

export type DocumentCommandExitCode = 0 | 1 | 2 | 3 | 130;

export interface DocumentRecoveryCommand {
  readonly commandId: "detach" | "docs.recover" | "scaffold-recover";
  readonly args: Readonly<Record<string, string>>;
}

export type DocumentCommandRemediation = DocumentRecoveryCommand | {
  readonly commandId: DocumentCommandId;
  readonly args: Readonly<Record<string, string>>;
};

export interface DocumentCommandDiagnostic {
  readonly ruleId: string;
  readonly severity: "error" | "info" | "warning";
  readonly phase:
    | "apply"
    | "authority"
    | "input"
    | "planning"
    | "recovery";
  readonly subject: string;
  readonly message: string;
  readonly remediation?: DocumentCommandRemediation;
}

export interface DocumentCommandEnvelope<Result> {
  readonly schemaVersion: 2;
  readonly command: DocumentCommandId;
  readonly outcome: DocumentCommandOutcome;
  readonly diagnostics: readonly DocumentCommandDiagnostic[];
  readonly result: Result;
}

export interface DocumentCommandExecution<Result> {
  readonly envelope: DocumentCommandEnvelope<Result>;
  readonly exitCode: DocumentCommandExitCode;
}

export interface DocumentReachabilityProjection {
  readonly state: "managed" | "manual-required" | "not-required";
  readonly indexPath?: string;
  readonly markdownLink?: string;
}

export interface DocumentNewResult {
  readonly kind: "new";
  readonly documentPath?: string;
  readonly writeState?: "already-applied" | "applied" | "preview";
  readonly reservation: "none";
  readonly receiptOutcome?: DocumentReceiptOutcome;
  readonly reachability?: DocumentReachabilityProjection;
}

export interface DocumentDoctorResult {
  readonly kind: "doctor";
  readonly transactionState:
    | "corrupt"
    | "document"
    | "local-mode"
    | "none"
    | "scaffold"
    | "transition-residue"
    | "unknown"
    | "version-mismatch";
  readonly protocolKind?: "document-authoring" | "local-mode" | "scaffolding" | "unknown";
  readonly foundationVersion?: string;
  readonly foundationBuildIdentity?: string;
  readonly recoveryClass: "auto-recoverable" | "manual" | "not-required";
  readonly recoveryCommand?: DocumentRecoveryCommand;
}

export interface DocumentRecoverResult {
  readonly kind: "recover";
  readonly transactionState:
    | "already-applied"
    | "manual-required"
    | "no-pending-transaction"
    | "recovered"
    | "recovery-required"
    | "cancelled"
    | "failed";
  readonly writeState: "already-committed" | "committed" | "unchanged" | "unknown";
  readonly recoveryRequired: boolean;
  readonly receiptDigest?: string;
  readonly recoveryCommand?: DocumentRecoveryCommand;
}

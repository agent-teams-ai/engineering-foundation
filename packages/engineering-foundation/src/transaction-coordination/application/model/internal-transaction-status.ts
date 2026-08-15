import type {
  FoundationManualRecoveryReason,
  FoundationTransactionDiagnostic,
  FoundationTransactionStatus
} from "./transaction-status.js";

export type InternalFoundationManualRecoveryReason =
  | FoundationManualRecoveryReason
  | "journal-transition-residue"
  | "physical-identity-unverifiable";

export type InternalFoundationTransactionStatus =
  | Exclude<
      FoundationTransactionStatus,
      { readonly state: "manual-recovery-required" }
    >
  | {
      readonly state: "pending";
      readonly operationKind: "document-authoring";
      readonly format: "document-authoring-envelope-v3" | "document-authoring-envelope-v4";
      readonly foundationVersion: string;
      readonly foundationBuildIdentity: string;
      readonly recovery: {
        readonly commandId: "docs-recover";
        readonly exactFoundationVersion: string;
        readonly exactFoundationBuildIdentity: string;
      };
      readonly diagnostics: readonly FoundationTransactionDiagnostic[];
    }
  | {
      readonly state: "manual-recovery-required";
      readonly reason: InternalFoundationManualRecoveryReason;
      readonly operationKind?: "document-authoring" | "scaffolding";
      readonly format?: "envelope-v2" | "envelope-v3" | "envelope-v4";
      readonly foundationVersion?: string;
      readonly foundationBuildIdentity?: string;
      readonly diagnostics: readonly FoundationTransactionDiagnostic[];
    };

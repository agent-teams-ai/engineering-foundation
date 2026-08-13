export type FoundationMutationKind =
  | "attach"
  | "detach"
  | "document-authoring"
  | "scaffolding";

export type FoundationRecoveryRoute =
  | {
      readonly commandId: "scaffold-recover";
      readonly exactFoundationVersion: string;
      readonly exactFoundationBuildIdentity?: string;
    }
  | {
      readonly commandId: "detach";
    }
  | {
      readonly commandId: "docs-recover";
      readonly exactFoundationVersion: string;
      readonly exactFoundationBuildIdentity: string;
    };

export type FoundationTransactionDiagnostic =
  | {
      readonly code: "FOUNDATION_TRANSACTION_ACTIVE";
      readonly message: string;
    }
  | {
      readonly code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED";
      readonly message: string;
    }
  | {
      readonly code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH";
      readonly message: string;
    };

export type FoundationManualRecoveryReason =
  | "corrupt-or-incompatible"
  | "invalid-slot"
  | "journal-transition-residue"
  | "local-mode-evidence-invalid"
  | "multiple-transactions"
  | "orphan-temporary"
  | "physical-identity-unverifiable"
  | "recovery-handler-unavailable"
  | "unstable-slot"
  | "unsupported-schema";

export type FoundationTransactionStatus =
  | {
      readonly state: "idle";
      readonly diagnostics: readonly [];
    }
  | {
      readonly state: "pending";
      readonly operationKind: "scaffolding";
      readonly format: "legacy-scaffolding-v1";
      readonly foundationVersion: string;
      readonly recovery: FoundationRecoveryRoute;
      readonly diagnostics: readonly FoundationTransactionDiagnostic[];
    }
  | {
      readonly state: "pending";
      readonly operationKind: "document-authoring";
      readonly format: "document-authoring-envelope-v3";
      readonly foundationVersion: string;
      readonly foundationBuildIdentity: string;
      readonly recovery: Extract<
        FoundationRecoveryRoute,
        { readonly commandId: "docs-recover" }
      >;
      readonly diagnostics: readonly FoundationTransactionDiagnostic[];
    }
  | {
      readonly state: "pending";
      readonly operationKind: "local-mode";
      readonly format: "local-mode-v1";
      readonly recovery: { readonly commandId: "detach" };
      readonly diagnostics: readonly FoundationTransactionDiagnostic[];
    }
  | {
      readonly state: "manual-recovery-required";
      readonly reason: FoundationManualRecoveryReason;
      readonly operationKind?: "document-authoring" | "scaffolding";
      readonly format?: "envelope-v2" | "envelope-v3";
      readonly foundationVersion?: string;
      readonly foundationBuildIdentity?: string;
      readonly diagnostics: readonly FoundationTransactionDiagnostic[];
    };

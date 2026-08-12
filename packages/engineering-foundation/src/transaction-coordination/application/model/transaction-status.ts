export type FoundationMutationKind =
  | "attach"
  | "detach"
  | "document-authoring"
  | "scaffolding"
  | "version-switch";

export type FoundationRecoveryRoute =
  | {
      readonly commandId: "scaffold-recover";
      readonly exactFoundationVersion: string;
    }
  | {
      readonly commandId: "docs-recover";
      readonly exactFoundationVersion: string;
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

export type FoundationTransactionStatus =
  | {
      readonly state: "idle";
      readonly diagnostics: readonly [];
    }
  | {
      readonly state: "pending";
      readonly operationKind: "document-authoring" | "scaffolding";
      readonly format: "envelope-v2" | "legacy-scaffolding-v1";
      readonly foundationVersion: string;
      readonly recovery: FoundationRecoveryRoute;
      readonly diagnostics: readonly FoundationTransactionDiagnostic[];
    }
  | {
      readonly state: "manual-recovery-required";
      readonly diagnostics: readonly FoundationTransactionDiagnostic[];
    };

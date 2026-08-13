export type DocumentTransactionInspectionDiagnostic =
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

export type DocumentTransactionInspectionV1 =
  | {
      readonly schemaVersion: 1;
      readonly state: "idle";
      readonly diagnostics: readonly [];
    }
  | {
      readonly schemaVersion: 1;
      readonly state: "recoverable";
      readonly operationKind: "document-authoring";
      readonly format: "document-authoring-envelope-v3";
      readonly foundationVersion: string;
      readonly foundationBuildIdentity: string;
      readonly recovery: {
        readonly commandId: "docs-recover";
        readonly exactFoundationVersion: string;
        readonly exactFoundationBuildIdentity: string;
      };
      readonly diagnostics: readonly DocumentTransactionInspectionDiagnostic[];
    }
  | {
      readonly schemaVersion: 1;
      readonly state: "manual-recovery-required";
      readonly reason: string;
      readonly operationKind?: "document-authoring" | "local-mode" | "scaffolding";
      readonly diagnostics: readonly DocumentTransactionInspectionDiagnostic[];
    };

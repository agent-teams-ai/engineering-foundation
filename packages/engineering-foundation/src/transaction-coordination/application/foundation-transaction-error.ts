import type {
  FoundationMutationKind,
  FoundationTransactionDiagnostic,
  FoundationTransactionStatus
} from "./model/transaction-status.js";

export class FoundationTransactionError extends Error {
  readonly code:
    | "FOUNDATION_TRANSACTION_ACTIVE"
    | "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED"
    | "FOUNDATION_TRANSACTION_VERSION_MISMATCH";
  readonly diagnostics: readonly FoundationTransactionDiagnostic[];
  readonly requestedMutation: FoundationMutationKind;
  readonly status: Exclude<FoundationTransactionStatus, { readonly state: "idle" }>;

  constructor(options: {
    readonly requestedMutation: FoundationMutationKind;
    readonly status: Exclude<FoundationTransactionStatus, { readonly state: "idle" }>;
  }) {
    const primary = options.status.diagnostics[0] ?? {
      code: "FOUNDATION_TRANSACTION_ACTIVE" as const,
      message: "A Foundation transaction requires recovery before another mutation can start."
    };
    super(primary.message);
    this.name = "FoundationTransactionError";
    this.code = primary.code;
    this.diagnostics = options.status.diagnostics;
    this.requestedMutation = options.requestedMutation;
    this.status = options.status;
  }
}

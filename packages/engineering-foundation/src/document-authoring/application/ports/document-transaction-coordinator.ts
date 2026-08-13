export type DocumentTransactionStatus =
  | { readonly state: "idle" }
  | { readonly state: "recoverable" }
  | { readonly state: "manual-recovery-required"; readonly reason: string };

export interface DocumentTransactionLease {
  readonly status: DocumentTransactionStatus;
  release(options?: { readonly retainTransactionBarrier?: boolean }): Promise<void>;
}

export interface DocumentTransactionCoordinator {
  inspect(): Promise<DocumentTransactionStatus>;
  acquire(request: {
    readonly mode: "apply" | "recover";
  }): Promise<DocumentTransactionLease>;
}

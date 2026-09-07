export interface DocsInitRequest {
  readonly consumerRoot: string;
  readonly ownerId: string;
  readonly projectId: string;
}

export interface DocsInitApplyRequest extends DocsInitRequest {
  readonly expectedPlanDigest: `sha256:${string}`;
}

export interface DocsInitFilePlan {
  readonly ownership: "create-only" | "managed-block";
  readonly path: string;
  readonly writeState: "blocked" | "create" | "current" | "replace";
}

export interface DocsInitIssue {
  readonly code:
    | "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE"
    | "PORTABLE_BOOTSTRAP_CONFLICT"
    | "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS";
  readonly message: string;
  readonly path: string;
}

export interface DocsInitPlan {
  readonly kind: "init";
  readonly operation: "plan";
  readonly writeState: "blocked" | "current" | "preview";
  readonly planDigest: `sha256:${string}`;
  readonly files: readonly DocsInitFilePlan[];
  readonly issues: readonly DocsInitIssue[];
}

export interface DocsInitExecution extends Omit<DocsInitPlan, "writeState"> {
  readonly writeState: "applied" | "current";
  readonly receiptDigest: `sha256:${string}`;
  readonly receiptOutcome: "already-satisfied" | "applied" | "rolled-back";
}

export interface DocsInitRecoveryRequired {
  readonly kind: "init";
  readonly operation: "recover";
  readonly writeState: "blocked";
  readonly message: string;
}

export interface DocsInitOperationActive {
  readonly kind: "init";
  readonly operation: "wait";
  readonly writeState: "blocked";
  readonly reason: "operation-active";
  readonly message: string;
}

export type DocsInitBarrier = DocsInitOperationActive | DocsInitRecoveryRequired;
export type DocsInitApplyResult = DocsInitExecution | DocsInitBarrier;

export type DocsInitRecovery =
  | Readonly<{ readonly kind: "init"; readonly operation: "recover"; readonly writeState: "unchanged" }>
  | Readonly<{ readonly kind: "init"; readonly operation: "recover"; readonly writeState: "blocked"; readonly message: string }>
  | DocsInitOperationActive
  | Readonly<{
      readonly kind: "init";
      readonly operation: "recover";
      readonly writeState: "recovered";
      readonly receiptDigest: `sha256:${string}`;
      readonly receiptOutcome: "already-satisfied" | "applied" | "rolled-back";
    }>;

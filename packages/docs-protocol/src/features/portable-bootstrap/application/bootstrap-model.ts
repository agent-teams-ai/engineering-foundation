export type PortableBootstrapMode = "dry-run" | "apply";
export type PortableBootstrapWriteState = "blocked" | "create" | "current" | "replace";

export interface PortableBootstrapInput {
  readonly consumerRoot: string;
  readonly mode: PortableBootstrapMode;
  readonly ownerId: string;
  readonly projectId: string;
}

export interface ApplyPortableBootstrapInput extends PortableBootstrapInput {
  readonly expectedPlanDigest: `sha256:${string}`;
  readonly mode: "apply";
}

export interface PortableBootstrapFilePlan {
  readonly ownership: "create-only" | "managed-block";
  readonly path: string;
  readonly writeState: PortableBootstrapWriteState;
}

export interface PortableBootstrapIssue {
  readonly code:
    | "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE"
    | "PORTABLE_BOOTSTRAP_CONFLICT"
    | "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS";
  readonly message: string;
  readonly path: string;
}

export interface PortableBootstrapPlan {
  readonly schemaVersion: 1;
  readonly protocol: "agent-teams.docs-protocol.portable-bootstrap/v1";
  readonly mode: PortableBootstrapMode;
  readonly outcome: "blocked" | "change-required" | "current";
  readonly planDigest: `sha256:${string}`;
  readonly files: readonly PortableBootstrapFilePlan[];
  readonly issues: readonly PortableBootstrapIssue[];
  readonly transactionPlan?: BootstrapTransactionPlan;
}

export interface PortableBootstrapExecution {
  readonly outcome: "applied" | "current";
  readonly plan: PortableBootstrapPlan;
  readonly receipt: BootstrapReceipt;
}


/** Encoded immutable bytes cross the IO boundary, never a file handle or Buffer. */
export interface BootstrapFileImage { readonly contentBase64: string; readonly mode?: number }
export interface BootstrapObservedFile extends BootstrapFileImage { readonly mode: number }
export type BootstrapOperation = {
  readonly path: string;
  readonly precondition: { readonly state: "absent" };
  readonly postimage: BootstrapFileImage;
} | {
  readonly path: string;
  readonly precondition: { readonly state: "known-file"; readonly acceptedPreimages: readonly BootstrapObservedFile[] };
  readonly postimage: BootstrapObservedFile;
};
export interface BootstrapTransactionPlan { readonly planDigest: `sha256:${string}`; readonly serializedPlan: string }
export interface BootstrapReceipt {
  readonly outcome: "already-satisfied" | "applied" | "rolled-back";
  readonly receiptDigest: `sha256:${string}`;
  readonly planDigest: `sha256:${string}`;
}
export type BootstrapBarrier = { readonly state: "idle" } | {
  readonly state: "recovery-required";
  readonly code: string;
  readonly message: string;
  readonly recoverableByInstalledBuild: boolean;
};
export interface BootstrapRepository {
  canonicalRoot(consumerRoot: string): Promise<string>;
  observe(root: string, repositoryPath: string): Promise<BootstrapObservedFile | undefined>;
}
export interface BootstrapTransactions {
  compile(operations: readonly BootstrapOperation[]): BootstrapTransactionPlan;
  apply(input: { readonly consumerRoot: string; readonly plan: BootstrapTransactionPlan }): Promise<BootstrapReceipt>;
  inspect(input: { readonly consumerRoot: string }): Promise<BootstrapBarrier>;
  recover(input: { readonly consumerRoot: string }): Promise<BootstrapReceipt>;
}
export interface PortableBootstrapPorts {
  readonly repository: BootstrapRepository;
  readonly transactions: BootstrapTransactions;
}

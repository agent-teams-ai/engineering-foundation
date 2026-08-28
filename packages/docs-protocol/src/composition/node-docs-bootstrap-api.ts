import {
  applyPortableBootstrap,
  compilePortableBootstrap,
  inspectPortableBootstrap,
  recoverPortableBootstrap,
  type PortableBootstrapPlan
} from "../community/bootstrap/index.js";

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

function projectPlan(plan: PortableBootstrapPlan): DocsInitPlan {
  return Object.freeze({
    kind: "init",
    operation: "plan",
    writeState: plan.outcome === "blocked" ? "blocked"
      : plan.outcome === "current" ? "current"
        : "preview",
    planDigest: plan.planDigest,
    files: plan.files,
    issues: plan.issues
  });
}

function recoveryRequiredMessage(recoverableByInstalledBuild: boolean): string {
  return recoverableByInstalledBuild
    ? "An interrupted bootstrap transaction must be recovered. Run docs-protocol init --recover for this consumer before retrying --apply."
    : "An interrupted bootstrap transaction requires its exact originating Foundation build; restore that build, then run docs-protocol init --recover before retrying --apply.";
}

/** Detects a transaction barrier before bootstrap planning or mutation. */
export async function docsInitApplyPreflight(
  input: { readonly consumerRoot: string }
): Promise<DocsInitBarrier | undefined> {
  const inspection = await inspectPortableBootstrap(input);
  if (inspection.state === "idle") {return undefined;}
  if (inspection.code === "KNOWN_FILE_OPERATION_ACTIVE") {
    return Object.freeze({
      kind: "init",
      operation: "wait",
      writeState: "blocked",
      reason: "operation-active",
      message: "Another Foundation operation is active. Wait for it to finish, then retry the init preview or --apply; recovery is not applicable to a live operation."
    });
  }
  return Object.freeze({
    kind: "init",
    operation: "recover",
    writeState: "blocked",
    message: recoveryRequiredMessage(inspection.recoverableByInstalledBuild)
  });
}

/** Compiles a non-mutating, non-reserving portable bootstrap preview. */
export async function docsInitPlan(input: DocsInitRequest): Promise<DocsInitPlan> {
  return projectPlan(await compilePortableBootstrap({ ...input, mode: "dry-run" }));
}

/** Recompiles and applies only the exact portable bootstrap preview selected by digest. */
export async function docsInitApply(input: DocsInitApplyRequest): Promise<DocsInitApplyResult> {
  const barrier = await docsInitApplyPreflight(input);
  if (barrier !== undefined) {return barrier;}
  const applied = await applyPortableBootstrap({
    consumerRoot: input.consumerRoot,
    ownerId: input.ownerId,
    projectId: input.projectId,
    mode: "apply",
    expectedPlanDigest: input.expectedPlanDigest
  });
  return Object.freeze({
    ...projectPlan(applied.plan),
    writeState: applied.outcome,
    receiptDigest: applied.receipt.receiptDigest,
    receiptOutcome: applied.receipt.outcome
  });
}

/** Recovers an interrupted known-file bootstrap transaction with the installed build. */
export async function docsInitRecover(input: { readonly consumerRoot: string }): Promise<DocsInitRecovery> {
  const inspection = await inspectPortableBootstrap(input);
  if (inspection.state === "idle") {
    return Object.freeze({ kind: "init", operation: "recover", writeState: "unchanged" });
  }
  if (inspection.code === "KNOWN_FILE_OPERATION_ACTIVE") {
    return Object.freeze({
      kind: "init",
      operation: "wait",
      writeState: "blocked",
      reason: "operation-active",
      message: "Another Foundation operation is active. Wait for it to finish, then retry the intended init command; recovery is not applicable to a live operation."
    });
  }
  if (!inspection.recoverableByInstalledBuild) {
    return Object.freeze({
      kind: "init",
      operation: "recover",
      writeState: "blocked",
      message: inspection.message
    });
  }
  const receipt = await recoverPortableBootstrap(input);
  return Object.freeze({
    kind: "init",
    operation: "recover",
    writeState: "recovered",
    receiptDigest: receipt.receiptDigest,
    receiptOutcome: receipt.outcome
  });
}

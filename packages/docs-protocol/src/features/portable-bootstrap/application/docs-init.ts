import { compilePortableBootstrap, applyPortableBootstrap } from "./portable-bootstrap.js";
import type { PortableBootstrapPorts, PortableBootstrapPlan } from "./bootstrap-model.js";
import type { DocsInitRequest, DocsInitApplyRequest, DocsInitPlan, DocsInitBarrier, DocsInitApplyResult, DocsInitRecovery } from "./docs-init-model.js";

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

export function createDocsInit(ports: PortableBootstrapPorts) {
  /** Detects a transaction barrier before bootstrap planning or mutation. */
  async function docsInitApplyPreflight(
    input: { readonly consumerRoot: string }
  ): Promise<DocsInitBarrier | undefined> {
    const inspection = await ports.transactions.inspect(input);
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
  async function docsInitPlan(input: DocsInitRequest): Promise<DocsInitPlan> {
    return projectPlan(await compilePortableBootstrap({ ...input, mode: "dry-run" }, ports));
  }

  /** Recompiles and applies only the exact portable bootstrap preview selected by digest. */
  async function docsInitApply(input: DocsInitApplyRequest): Promise<DocsInitApplyResult> {
    const barrier = await docsInitApplyPreflight(input);
    if (barrier !== undefined) {return barrier;}
    const applied = await applyPortableBootstrap({
      consumerRoot: input.consumerRoot,
      ownerId: input.ownerId,
      projectId: input.projectId,
      mode: "apply",
      expectedPlanDigest: input.expectedPlanDigest
    }, ports);
    return Object.freeze({
      ...projectPlan(applied.plan),
      writeState: applied.outcome,
      receiptDigest: applied.receipt.receiptDigest,
      receiptOutcome: applied.receipt.outcome
    });
  }

  /** Recovers an interrupted known-file bootstrap transaction with the installed build. */
  async function docsInitRecover(input: { readonly consumerRoot: string }): Promise<DocsInitRecovery> {
    const inspection = await ports.transactions.inspect(input);
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
    const receipt = await ports.transactions.recover(input);
    return Object.freeze({
      kind: "init",
      operation: "recover",
      writeState: "recovered",
      receiptDigest: receipt.receiptDigest,
      receiptOutcome: receipt.outcome
    });
  }

  return { docsInitApplyPreflight, docsInitPlan, docsInitApply, docsInitRecover };
}

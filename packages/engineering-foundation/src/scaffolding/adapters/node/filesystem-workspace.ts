import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  MaterializeFileOperationV1,
  ScaffoldDiagnosticV1,
  ScaffoldOperationReceiptV1,
  ScaffoldPlanV1,
  ScaffoldReceiptV1
} from "../../contract/types.js";
import { assertScaffoldPlanDigest } from "../../kernel/rendering-plan-validation.js";
import { createScaffoldReceipt } from "../../kernel/receipt.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  acquireFoundationOperationLock
} from "../../../local-mode/service.js";
import { LOCAL_STATE_DIRECTORY } from "../../../local-mode/types.js";
import { inspectAuthorityReadSet } from "./node-input-loader.js";
import { assertRenderingPlanMatchesConsumerAuthority } from "./node-rendering-plan-authority.js";
import {
  assertSafeExistingAncestors,
  assertSafeOperationPaths,
  syncDirectory
} from "./filesystem-path-guard.js";
import {
  assertTransactionTemporariesAbsent,
  classifyFilesystemPlan,
  type FilesystemOperationState,
  publishFilesystemOperation,
  removeTransactionTemporary
} from "./filesystem-operation-state.js";
import {
  readScaffoldJournal,
  removeScaffoldJournal,
  SCAFFOLD_JOURNAL_FILE,
  writeScaffoldJournal
} from "./filesystem-rendering-journal.js";

function diagnostic(
  ruleId: string,
  phase: ScaffoldDiagnosticV1["phase"],
  subject: string,
  message: string,
  remediation: string
): ScaffoldDiagnosticV1 {
  return Object.freeze({
    ruleId,
    severity: "error" as const,
    phase,
    subject,
    message,
    remediation
  });
}

function conflictReceipt(
  plan: ScaffoldPlanV1,
  classifications: readonly {
    readonly operation: MaterializeFileOperationV1;
    readonly state: FilesystemOperationState;
  }[],
  phase: "apply" | "recovery"
): ScaffoldReceiptV1 {
  const conflicting = classifications.filter(({ state }) => state === "conflict");
  return createScaffoldReceipt({
    plan,
    adapterId: "foundation.filesystem/v1",
    outcome: phase === "recovery" ? "recovery-required" : "rejected",
    commitState: phase === "recovery" ? "recovery-required" : "rejected",
    atomicity: "journaled-recoverable",
    operations: classifications.map(({ operation, state }) => ({
      operationId: operation.id,
      path: operation.path,
      outcome:
        state === "conflict"
          ? "conflict"
          : state === "after"
            ? "already-satisfied"
            : "not-applied",
      ...(state === "after" ? { resultDigest: operation.after.digest } : {})
    })),
    diagnostics: conflicting.map(({ operation }) =>
      diagnostic(
        phase === "recovery"
          ? "scaffolding.recovery.third-state"
          : "scaffolding.apply.precondition-conflict",
        phase,
        operation.path,
        "File matches neither the Plan precondition nor its desired result.",
        phase === "recovery"
          ? "Resolve the file manually, then retry recovery."
          : "Create a new Intent and Plan from the current workspace state."
      )
    )
  });
}

async function finishPlan(
  root: string,
  plan: ScaffoldPlanV1,
  recovered: boolean,
  faultInjector?: ScaffoldFilesystemFaultInjector
): Promise<ScaffoldReceiptV1> {
  await assertRenderingPlanMatchesConsumerAuthority(root, plan);
  for (const operation of plan.operations) {
    await removeTransactionTemporary(root, plan.planDigest, operation);
  }
  const initial = await classifyFilesystemPlan(root, plan);
  if (initial.some(({ state }) => state === "conflict")) {
    return conflictReceipt(plan, initial, recovered ? "recovery" : "apply");
  }
  const operationReceipts: ScaffoldOperationReceiptV1[] = [];
  for (const [operationIndex, { operation, state }] of initial.entries()) {
    if (recovered && state === "after") {
      await syncDirectory(dirname(resolve(root, operation.path)));
    }
    const outcome =
      state === "after"
        ? "already-satisfied"
        : await publishFilesystemOperation(
            root,
            operation,
            plan.planDigest,
            operationIndex,
            faultInjector
          );
    operationReceipts.push({
      operationId: operation.id,
      path: operation.path,
      outcome: recovered && outcome === "applied" ? "recovered" : outcome,
      resultDigest: operation.after.digest
    });
    await faultInjector?.({
      phase: "after-operation-published",
      operationIndex,
      operationPath: operation.path
    });
  }
  const finalState = await classifyFilesystemPlan(root, plan);
  if (finalState.some(({ state }) => state !== "after")) {
    return conflictReceipt(plan, finalState, "recovery");
  }
  return createScaffoldReceipt({
    plan,
    adapterId: "foundation.filesystem/v1",
    outcome: recovered ? "failed-recovered" : "applied",
    commitState: recovered ? "recovered" : "committed",
    atomicity: "journaled-recoverable",
    operations: operationReceipts
  });
}

async function recoverFilesystemScaffoldV1(
  consumerRoot: string
): Promise<ScaffoldReceiptV1 | undefined> {
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const release = await acquireFoundationOperationLock(canonicalRoot);
  try {
    const journalPath = join(
      canonicalRoot,
      LOCAL_STATE_DIRECTORY,
      SCAFFOLD_JOURNAL_FILE
    );
    const journalPlan = await readScaffoldJournal(journalPath);
    if (journalPlan === undefined) {
      return undefined;
    }
    assertSafeOperationPaths(journalPlan);
    for (const operation of journalPlan.operations) {
      await assertSafeExistingAncestors(canonicalRoot, operation.path);
    }
    const receipt = await finishPlan(canonicalRoot, journalPlan, true);
    if (receipt.outcome !== "recovery-required") {
      await removeScaffoldJournal(journalPath);
    }
    return receipt;
  } finally {
    await release();
  }
}

async function applyFilesystemScaffoldV1(
  consumerRoot: string,
  plan: ScaffoldPlanV1
): Promise<ScaffoldReceiptV1> {
  return applyFilesystemScaffoldWithFaultInjection(consumerRoot, plan);
}

/** Retains the released 0.5 recovery contract for regression evidence only. */
export async function recoverFilesystemScaffold(
  consumerRoot: string
): Promise<ScaffoldReceiptV1 | undefined> {
  return recoverFilesystemScaffoldV1(consumerRoot);
}

export async function applyFilesystemScaffold(
  consumerRoot: string,
  plan: ScaffoldPlanV1
): Promise<ScaffoldReceiptV1> {
  return applyFilesystemScaffoldV1(consumerRoot, plan);
}


interface ScaffoldFilesystemFaultPoint {
  readonly phase:
    | "after-journal-prepared"
    | "after-hard-link"
    | "after-operation-published"
    | "after-temporary-synced"
    | "after-temporary-written"
    | "before-journal-removed";
  readonly operationIndex?: number;
  readonly operationPath?: string;
}

type ScaffoldFilesystemFaultInjector = (
  point: ScaffoldFilesystemFaultPoint
) => Promise<void> | void;

/** Internal conformance seam. It is intentionally absent from package exports. */
export async function applyFilesystemScaffoldWithFaultInjection(
  consumerRoot: string,
  plan: ScaffoldPlanV1,
  faultInjector?: ScaffoldFilesystemFaultInjector
): Promise<ScaffoldReceiptV1> {
  await assertSchema("scaffold-plan/v1", plan, "scaffold-apply-plan");
  assertScaffoldPlanDigest(plan);
  assertSafeOperationPaths(plan);
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const release = await acquireFoundationOperationLock(canonicalRoot);
  try {
    const journalPath = join(
      canonicalRoot,
      LOCAL_STATE_DIRECTORY,
      SCAFFOLD_JOURNAL_FILE
    );
    const existingPlan = await readScaffoldJournal(journalPath);
    if (
      existingPlan !== undefined &&
      existingPlan.planDigest !== plan.planDigest
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "A different scaffolding Plan requires recovery before this Plan can apply."
      );
    }
    if (existingPlan !== undefined) {
      for (const operation of existingPlan.operations) {
        await assertSafeExistingAncestors(canonicalRoot, operation.path);
      }
      const recovered = await finishPlan(canonicalRoot, existingPlan, true);
      if (recovered.outcome !== "recovery-required") {
        await removeScaffoldJournal(journalPath);
      }
      return recovered;
    }

    if (!(await inspectAuthorityReadSet(canonicalRoot, plan.readSet))) {
      return createScaffoldReceipt({
        plan,
        adapterId: "foundation.filesystem/v1",
        outcome: "rejected",
        commitState: "rejected",
        atomicity: "journaled-recoverable",
        operations: [],
        diagnostics: [
          diagnostic(
            "scaffolding.apply.stale-authority-snapshot",
            "apply",
            plan.projectId,
            "Consumer configuration or target authority changed after planning.",
            "Compile a new Plan from the current consumer state."
          )
        ]
      });
    }
    await assertRenderingPlanMatchesConsumerAuthority(canonicalRoot, plan);
    const classifications = await classifyFilesystemPlan(canonicalRoot, plan);
    if (classifications.some(({ state }) => state === "conflict")) {
      return conflictReceipt(plan, classifications, "apply");
    }
    if (classifications.every(({ state }) => state === "after")) {
      return createScaffoldReceipt({
        plan,
        adapterId: "foundation.filesystem/v1",
        outcome: "already-applied",
        commitState: "committed",
        atomicity: "journaled-recoverable",
        operations: classifications.map(({ operation }) => ({
          operationId: operation.id,
          path: operation.path,
          outcome: "already-satisfied",
          resultDigest: operation.after.digest
        }))
      });
    }

    for (const operation of plan.operations) {
      await assertSafeExistingAncestors(canonicalRoot, operation.path);
    }
    await assertTransactionTemporariesAbsent(canonicalRoot, plan);

    await writeScaffoldJournal(journalPath, plan);
    await faultInjector?.({ phase: "after-journal-prepared" });
    try {
      const receipt = await finishPlan(canonicalRoot, plan, false, faultInjector);
      if (receipt.outcome !== "recovery-required") {
        await faultInjector?.({ phase: "before-journal-removed" });
        await removeScaffoldJournal(journalPath);
      }
      return receipt;
    } catch {
      const recovered = await finishPlan(canonicalRoot, plan, true);
      if (recovered.outcome !== "recovery-required") {
        await removeScaffoldJournal(journalPath);
      }
      return recovered;
    }
  } finally {
    await release();
  }
}

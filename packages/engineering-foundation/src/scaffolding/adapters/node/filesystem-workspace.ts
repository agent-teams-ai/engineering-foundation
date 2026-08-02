import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type {
  MaterializeFileOperationV1,
  ScaffoldDiagnosticV1,
  ScaffoldOperationReceiptV1,
  ScaffoldPlanV1,
  ScaffoldReceiptV1
} from "../../contract/types.js";
import { sha256Bytes, sha256Text } from "../../kernel/canonical-json.js";
import { assertScaffoldPlanDigest } from "../../kernel/plan-validation.js";
import { createScaffoldReceipt } from "../../kernel/receipt.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  acquireFoundationOperationLock
} from "../../../local-mode/service.js";
import { LOCAL_STATE_DIRECTORY } from "../../../local-mode/types.js";
import { inspectAuthorityReadSet } from "./node-input-loader.js";
import { assertPlanMatchesConsumerAuthority } from "./node-plan-authority.js";
import {
  assertSafeExistingAncestors,
  assertSafeOperationPaths,
  ensureSafeParent,
  isContainedPath,
  syncDirectory
} from "./filesystem-path-guard.js";
import {
  readScaffoldJournal,
  removeScaffoldJournal,
  SCAFFOLD_JOURNAL_FILE,
  writeScaffoldJournal
} from "./filesystem-journal.js";

type FileState = "absent" | "after" | "conflict";

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

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function classifyFile(
  root: string,
  operation: MaterializeFileOperationV1
): Promise<FileState> {
  const destination = resolve(root, operation.path);
  if (!isContainedPath(root, destination)) {
    return "conflict";
  }
  try {
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return "conflict";
    }
    const bytes = await readFile(destination);
    const modeMatches =
      process.platform === "win32" || (metadata.mode & 0o777) === 0o644;
    return sha256Bytes(bytes) === operation.after.digest && modeMatches
      ? "after"
      : "conflict";
  } catch (error) {
    if (isMissing(error)) {
      return "absent";
    }
    throw error;
  }
}

function transactionTemporaryName(
  planDigest: string,
  operation: MaterializeFileOperationV1
): string {
  const identity = sha256Text(`${planDigest}:${operation.id}`).slice(
    "sha256:".length
  );
  return `.foundation-${identity}.tmp`;
}

async function removeTransactionTemporary(
  root: string,
  planDigest: string,
  operation: MaterializeFileOperationV1
): Promise<void> {
  const parent = dirname(resolve(root, operation.path));
  const temporary = join(parent, transactionTemporaryName(planDigest, operation));
  try {
    const metadata = await lstat(temporary);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Scaffolding temporary path is not a file: ${operation.path}.`
      );
    }
    await rm(temporary, { force: true });
    await syncDirectory(parent);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function assertTransactionTemporariesAbsent(
  root: string,
  plan: ScaffoldPlanV1
): Promise<void> {
  for (const operation of plan.operations) {
    const parent = dirname(resolve(root, operation.path));
    const temporary = join(
      parent,
      transactionTemporaryName(plan.planDigest, operation)
    );
    const metadata = await lstat(temporary).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });
    if (metadata !== null) {
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding transaction temporary path already exists: ${operation.path}.`
      );
    }
  }
}

async function publishOperation(
  root: string,
  operation: MaterializeFileOperationV1,
  planDigest: string,
  operationIndex: number,
  faultInjector?: ScaffoldFilesystemFaultInjector
): Promise<"already-satisfied" | "applied"> {
  const state = await classifyFile(root, operation);
  if (state === "after") {
    return "already-satisfied";
  }
  if (state === "conflict") {
    throw new ScaffoldError(
      "SCAFFOLD_APPLY_CONFLICT",
      `Scaffolding output changed concurrently: ${operation.path}.`
    );
  }
  const parent = await ensureSafeParent(root, operation.path);
  const destination = join(parent, basename(operation.path));
  const temporary = join(parent, transactionTemporaryName(planDigest, operation));
  const bytes = Buffer.from(operation.after.contentBase64, "base64");
  await rm(temporary, { force: true });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await faultInjector?.({
        phase: "after-temporary-written",
        operationIndex,
        operationPath: operation.path
      });
      await handle.chmod(0o644);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await faultInjector?.({
      phase: "after-temporary-synced",
      operationIndex,
      operationPath: operation.path
    });
    try {
      await link(temporary, destination);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        const concurrentState = await classifyFile(root, operation);
        if (concurrentState === "after") {
          return "already-satisfied";
        }
        throw new ScaffoldError(
          "SCAFFOLD_APPLY_CONFLICT",
          `Scaffolding output changed concurrently: ${operation.path}.`,
          [],
          { cause: error }
        );
      }
      throw error;
    }
    await faultInjector?.({
      phase: "after-hard-link",
      operationIndex,
      operationPath: operation.path
    });
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true });
  }
  if ((await classifyFile(root, operation)) !== "after") {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      `Published scaffolding output failed digest verification: ${operation.path}.`
    );
  }
  return "applied";
}

async function classifyPlan(
  root: string,
  plan: ScaffoldPlanV1
): Promise<readonly {
  readonly operation: MaterializeFileOperationV1;
  readonly state: FileState;
}[]> {
  return Promise.all(
    plan.operations.map(async (operation) => ({
      operation,
      state: await classifyFile(root, operation)
    }))
  );
}

function conflictReceipt(
  plan: ScaffoldPlanV1,
  classifications: readonly {
    readonly operation: MaterializeFileOperationV1;
    readonly state: FileState;
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
  for (const operation of plan.operations) {
    await removeTransactionTemporary(root, plan.planDigest, operation);
  }
  const initial = await classifyPlan(root, plan);
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
        : await publishOperation(
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
  const finalState = await classifyPlan(root, plan);
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

export async function recoverFilesystemScaffold(
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

export async function applyFilesystemScaffold(
  consumerRoot: string,
  plan: ScaffoldPlanV1
): Promise<ScaffoldReceiptV1> {
  return applyFilesystemScaffoldWithFaultInjection(consumerRoot, plan);
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
    await assertPlanMatchesConsumerAuthority(canonicalRoot, plan);
    const classifications = await classifyPlan(canonicalRoot, plan);
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

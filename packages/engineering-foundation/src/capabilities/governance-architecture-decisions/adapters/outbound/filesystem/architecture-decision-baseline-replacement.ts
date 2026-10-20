import { open, rename, type FileHandle } from "node:fs/promises";

import {
  acquireMutationLease, observeMutationState, releaseMutationLease,
  retainMutationBarrierOnEvidence, NodeAtomicFileReplacementError,
  type MutationLease, type NodeAtomicFileReplacement
} from "@agent-teams/repository-mutation/node";
import { RepositoryMutationError } from "@agent-teams/repository-mutation/coordination";

import { assertBaselineObservationActive, assertExpectedBaselineState, baselineWriteFailure, rejectBaselineWrite } from "../../../application/policies/architecture-decision-baseline-input.js";
import type { ArchitectureDecisionBaselineExpectedState, ArchitectureDecisionBaselineReadResult, ArchitectureDecisionBaselineWriteResult } from "../../../application/ports/architecture-decision-baseline-repository.js";

export interface BaselineTarget {
  readonly candidate: string;
  readonly parent: string;
  readonly root: string;
  readonly replacement: NodeAtomicFileReplacement;
}

/** Exact effects required for baseline replacement and fault qualification. */
export interface BaselineReplacementOperations {
  readonly openTemporary: (path: string) => Promise<FileHandle>;
  readonly rename: (source: string, target: string) => Promise<void>;
  readonly syncParent: (parent: string) => Promise<void>;
  readonly cleanupTemporary: (replacement: NodeAtomicFileReplacement) => Promise<void>;
  readonly releaseLease: (lease: MutationLease) => Promise<void>;
}

async function syncParent(parent: string): Promise<void> {
  if (process.platform === "win32") { return; }
  let handle: FileHandle;
  try { handle = await open(parent, "r"); }
  catch (error) {
    rejectBaselineWrite("ARCHITECTURE_DECISION_BASELINE_WRITE_DURABILITY_FAILED",
      "Accepted-decision baseline was replaced but its parent directory could not be opened for flushing. Reconcile the baseline before retrying.",
      { cause: error });
  }
  const failures: unknown[] = [];
  try { await handle.sync(); } catch (error) { failures.push(error); }
  try { await handle.close(); } catch (error) { failures.push(error); }
  if (failures.length > 0) {
    rejectBaselineWrite("ARCHITECTURE_DECISION_BASELINE_WRITE_DURABILITY_FAILED",
      "Accepted-decision baseline was replaced but its parent directory could not be flushed. Reconcile the baseline before retrying.",
      { cause: failures.length === 1 ? failures[0] : new AggregateError(failures, "Baseline parent sync and close both failed.") });
  }
}

export const baselineReplacementOperations: BaselineReplacementOperations = {
  openTemporary: (path) => open(path, "wx", 0o644),
  rename,
  syncParent,
  cleanupTemporary: (replacement) => replacement.cleanup(),
  releaseLease: releaseMutationLease
};

function replacementFailure(error: unknown): unknown {
  if (!(error instanceof NodeAtomicFileReplacementError)) { return error; }
  const temporary = error.failure === "temporary-changed";
  return baselineWriteFailure(temporary ? "ARCHITECTURE_DECISION_BASELINE_WRITE_TEMPORARY_CHANGED"
      : "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT",
    temporary
      ? "Accepted-decision baseline temporary ownership changed. Foreign evidence was preserved; reconcile the temporary before retrying."
      : "Accepted-decision baseline directory changed during promotion. Reconcile the repository before retrying.",
    { cause: error });
}

function throwFailures(failures: readonly unknown[], replaced: boolean): void {
  if (failures.length === 1) { throw failures[0]; }
  if (failures.length > 1) {
    throw new AggregateError(failures, replaced
      ? "Accepted-decision baseline may already be replaced; finalization failed. Reconcile the baseline before retrying."
      : "Accepted-decision baseline replacement and resource finalization failed.",
    { cause: failures[0] });
  }
}

async function rejectCommonEvidence(lease: MutationLease): Promise<void> {
  await observeMutationState(lease);
  if (await retainMutationBarrierOnEvidence(lease)) {
    rejectBaselineWrite("ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT",
      "Common repository mutation evidence must be recovered before accepted-decision baseline promotion.");
  }
}

async function acquireBaselineLease(root: string): Promise<MutationLease> {
  try { return await acquireMutationLease(root); }
  catch (error) {
    if (!(error instanceof RepositoryMutationError)) { throw error; }
    rejectBaselineWrite("ARCHITECTURE_DECISION_BASELINE_WRITE_LOCK_UNAVAILABLE",
      "The repository mutation lease is unavailable. Reconcile active or interrupted operations before retrying baseline promotion.",
      { cause: error });
  }
}

export async function replaceArchitectureDecisionBaseline(input: {
  readonly expected: ArchitectureDecisionBaselineExpectedState;
  readonly source: string;
  readonly target: BaselineTarget;
  readonly signal?: AbortSignal;
  readonly ensureParent: () => Promise<void>;
  readonly inspect: () => Promise<{ readonly result: ArchitectureDecisionBaselineReadResult; readonly source?: string }>;
  readonly pathTraversesSymbolicLink: () => Promise<boolean>;
}, operations: BaselineReplacementOperations): Promise<ArchitectureDecisionBaselineWriteResult> {
  const { target } = input;
  const lease = await acquireBaselineLease(target.root);
  const failures: unknown[] = [];
  let result: ArchitectureDecisionBaselineWriteResult | undefined;
  let replaced = false;
  try {
    await target.replacement.assertCurrent();
    await rejectCommonEvidence(lease);
    await input.ensureParent();
    await target.replacement.bindParent();
    const secondRead = await input.inspect();
    assertExpectedBaselineState(secondRead.result, input.expected);
    if (secondRead.source?.replaceAll("\r\n", "\n") === input.source) {
      result = "unchanged";
    } else {
      assertBaselineObservationActive(input.signal);
      await target.replacement.prepare(Buffer.from(input.source, "utf8"), operations.openTemporary);
      assertBaselineObservationActive(input.signal);
      await target.replacement.assertCurrent();
      const finalRead = await input.inspect();
      assertExpectedBaselineState(finalRead.result, input.expected);
      if (finalRead.source?.replaceAll("\r\n", "\n") === input.source) {
        result = "unchanged";
      } else {
        await rejectCommonEvidence(lease);
        await target.replacement.assertCurrent();
        if (await input.pathTraversesSymbolicLink()) {
          rejectBaselineWrite("ARCHITECTURE_DECISION_BASELINE_WRITE_SYMLINK_PROHIBITED",
            "Accepted-decision baseline target traverses a symbolic link.");
        }
        assertBaselineObservationActive(input.signal);
        await target.replacement.replace(operations.rename);
        replaced = true;
        await operations.syncParent(target.parent);
        result = input.expected.kind === "missing" ? "created" : "updated";
      }
    }
  } catch (error) { failures.push(replacementFailure(error)); }
  try { await operations.cleanupTemporary(target.replacement); }
  catch (error) { failures.push(replacementFailure(error)); }
  try { await retainMutationBarrierOnEvidence(lease); } catch (error) { failures.push(error); }
  try { await operations.releaseLease(lease); } catch (error) { failures.push(error); }
  throwFailures(failures, replaced);
  if (result === undefined) { throw new Error("Baseline replacement did not settle an outcome."); }
  return result;
}

import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AuthorityScaffoldJournal,
  AuthorityScaffoldOperationReceipt,
  AuthorityScaffoldPlan, AuthorityScaffoldReceipt
} from "../../contract/types.js";
import { assertAuthorityScaffoldPlanDigest } from "../../kernel/plan-validation.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import { LOCAL_STATE_DIRECTORY } from "../../../foundation-state-contract.js";
import { createNodeFoundationTransactionCoordinator } from "../../../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import { FoundationTransactionError } from "../../../transaction-coordination/application/foundation-transaction-error.js";
import type { FoundationTransactionLease } from "../../../transaction-coordination/application/foundation-transaction-coordinator.js";
import { assessScaffoldPlanAuthority } from "./node-plan-authority.js";
import {
  assertSafeExistingAncestors, assertSafeOperationPaths
} from "./filesystem-path-guard.js";
import {
  assertTransactionTemporariesAbsent, publishFilesystemOperation
} from "./filesystem-operation-state.js";
import {
  freshAuthorityScaffoldJournal,
  receiptFromJournalStates,
  reconcileAuthorityScaffoldJournal,
  replaceScaffoldJournalOperation
} from "./filesystem-journal-state.js";
import {
  finalizeAuthorityScaffoldJournal,
  staleBeforeJournal,
  verifyAlreadyAppliedScaffold
} from "./filesystem-finalization.js";
import {
  recoveryRequiredForAuthority, resolveAuthority, safeClassifyPlan
} from "./filesystem-authority.js";
import {
  SCAFFOLD_JOURNAL_FILE
} from "./filesystem-journal.js";
import {
  createScaffoldJournalReconciled,
  readScaffoldJournal,
  replaceScaffoldJournalReconciled
} from "./node-scaffold-journal-gateway.js";
import {
  NodeScaffoldJournalStore,
  type ScaffoldJournalAuthority
} from "./node-scaffold-journal-store.js";
import { scaffoldTransactionEvidenceExists } from "./node-scaffold-journal-transaction-evidence.js";
import { createNodeFoundationCleanupTransition } from "../../../transaction-coordination/adapters/node/node-foundation-cleanup-transition.js";
import { sha256Text } from "../../kernel/canonical-json.js";

interface ScaffoldAuthorityFaultPoint {
  readonly phase:
    | "after-hard-link"
    | "after-journal-operation-published"
    | "after-journal-operation-publishing"
    | "after-journal-prepared"
    | "after-journal-temporary-synced"
    | "after-journal-unlinked"
    | "after-temporary-synced"
    | "after-temporary-written"
    | "after-final-verification"
    | "before-journal-quarantine"
    | "before-final-authority-recheck"
    | "before-operation-authority-recheck";
  readonly operationIndex?: number;
  readonly operationPath?: string;
}
type ScaffoldAuthorityFaultInjector = (
  point: ScaffoldAuthorityFaultPoint
) => Promise<void> | void;
function recoveryRequired(
  plan: AuthorityScaffoldPlan,
  phase: "apply" | "recovery",
  ruleId: string,
  message: string,
  remediation: string
): AuthorityScaffoldReceipt {
  return recoveryRequiredForAuthority({ plan, phase, ruleId, message, remediation });
}

interface AuthorityContinuationOptions {
  readonly root: string;
  readonly journalPath: string;
  readonly journal: AuthorityScaffoldJournal;
  readonly journalAuthority: ScaffoldJournalAuthority;
  readonly journalStore: NodeScaffoldJournalStore;
  readonly journalFaultContext: ScaffoldJournalFaultContext;
  readonly recovered: boolean;
  readonly faultInjector?: ScaffoldAuthorityFaultInjector;
}
interface ScaffoldJournalFaultContext {
  finalizing?: boolean;
  operationIndex?: number;
  operationPath?: string;
}
function isReceipt(value: unknown): value is AuthorityScaffoldReceipt {
  return typeof value === "object" && value !== null && "receiptDigest" in value;
}
function deepFreezePlanValue(value: unknown, visited: Set<object>): void {
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return;
  }
  visited.add(value);
  for (const child of Object.values(value)) {
    deepFreezePlanValue(child, visited);
  }
  Object.freeze(value);
}
function snapshotAuthorityScaffoldPlan(
  plan: AuthorityScaffoldPlan
): AuthorityScaffoldPlan {
  let snapshot: AuthorityScaffoldPlan;
  try {
    snapshot = structuredClone(plan);
    deepFreezePlanValue(snapshot, new Set());
  } catch (error) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Plan cannot be snapshotted as canonical data.",
      [],
      { cause: error }
    );
  }
  return snapshot;
}

async function acquireScaffoldingTransaction(
  canonicalRoot: string
): Promise<FoundationTransactionLease> {
  const coordinator = await createNodeFoundationTransactionCoordinator(canonicalRoot);
  try {
    return await coordinator.acquire({
      requestedMutation: "scaffolding",
      allowRecoveryOf: "scaffolding"
    });
  } catch (error) {
    if (!(error instanceof FoundationTransactionError)) {
      throw error;
    }
    const message =
      error.status.state === "manual-recovery-required" &&
      error.status.reason === "orphan-temporary"
      ? "Scaffolding journal temporary cannot be proven transaction-owned; it was preserved and requires manual recovery."
      : error.message;
    throw new ScaffoldError("SCAFFOLD_RECOVERY_REQUIRED", message, [], {
      cause: error
    });
  }
}

async function prepareJournal(
  options: AuthorityContinuationOptions
): Promise<
  | { readonly journal: AuthorityScaffoldJournal; readonly journalAuthority: ScaffoldJournalAuthority }
  | AuthorityScaffoldReceipt
> {
  let journal = options.journal;
  const initialAuthority = await resolveAuthority({ ...options, journal });
  if (initialAuthority !== undefined) {
    return initialAuthority;
  }
  try {
    await assertTransactionTemporariesAbsent(options.root, journal.plan);
    const reconciled = await reconcileAuthorityScaffoldJournal(options.root, journal);
    journal = reconciled.journal;
    if (reconciled.conflictIds.size !== 0) {
      await replaceScaffoldJournalReconciled(
        options.journalStore,
        { journal: options.journal, journalAuthority: options.journalAuthority },
        journal,
      );
      return receiptFromJournalStates({
        plan: journal.plan,
        journal,
        outcome: "recovery-required",
        phase: "recovery",
        conflictOperationIds: reconciled.conflictIds
      });
    }
  } catch {
    return recoveryRequired(
      journal.plan,
      options.recovered ? "recovery" : "apply",
      "scaffolding.recovery.unverifiable-workspace",
      "The workspace cannot be safely reconciled; no transaction output was removed.",
      "Resolve the filesystem state manually, then retry recovery."
    );
  }
  const journalAuthority = await replaceScaffoldJournalReconciled(
    options.journalStore,
    { journal: options.journal, journalAuthority: options.journalAuthority },
    journal
  );
  return { journal, journalAuthority };
}

async function publishPendingOperations(options: {
  readonly continuation: AuthorityContinuationOptions;
  readonly journal: AuthorityScaffoldJournal;
  readonly journalAuthority: ScaffoldJournalAuthority;
}): Promise<
  | AuthorityScaffoldReceipt
  | {
      readonly journal: AuthorityScaffoldJournal;
      readonly journalAuthority: ScaffoldJournalAuthority;
      readonly receipts: ReadonlyMap<string, AuthorityScaffoldOperationReceipt>;
    }
> {
  const { continuation } = options;
  let journal = options.journal;
  let journalAuthority = options.journalAuthority;
  const receipts = new Map<string, AuthorityScaffoldOperationReceipt>();
  for (const [operationIndex, operation] of journal.plan.operations.entries()) {
    const current = journal.operations.find(
      (candidate) => candidate.operationId === operation.id
    );
    if (current === undefined) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding source-bound journal operation is missing."
      );
    }
    if (current.state === "preexisting" || current.state === "published") {
      receipts.set(operation.id, {
        operationId: operation.id,
        path: operation.path,
        outcome: "already-satisfied",
        resultDigest: operation.after.digest
      });
      continue;
    }
    await continuation.faultInjector?.({
      phase: "before-operation-authority-recheck",
      operationIndex,
      operationPath: operation.path
    });
    const authority = await resolveAuthority({ ...continuation, journal });
    if (authority !== undefined) {
      return authority;
    }
    try {
      await assertSafeExistingAncestors(continuation.root, operation.path);
    } catch {
      return recoveryRequired(
        journal.plan,
        continuation.recovered ? "recovery" : "apply",
        "scaffolding.recovery.unsafe-ancestor",
        "Filesystem ancestry cannot be proven safe for publication.",
        "Resolve the filesystem state manually, then retry recovery."
      );
    }
    const beforePublishing = journal;
    journal = replaceScaffoldJournalOperation(journal, operation.id, "publishing");
    continuation.journalFaultContext.operationIndex = operationIndex;
    continuation.journalFaultContext.operationPath = operation.path;
    journalAuthority = await replaceScaffoldJournalReconciled(
      continuation.journalStore,
      { journal: beforePublishing, journalAuthority },
      journal
    );
    await continuation.faultInjector?.({
      phase: "after-journal-operation-publishing",
      operationIndex,
      operationPath: operation.path
    });
    const outcome = await publishFilesystemOperation({
      root: continuation.root,
      operation,
      planDigest: journal.plan.planDigest,
      operationIndex,
      ...(continuation.faultInjector === undefined
        ? {}
        : { faultInjector: continuation.faultInjector }),
      cleanupTransition: createNodeFoundationCleanupTransition(
        continuation.root,
        sha256Text(
          `${journal.plan.planDigest}:${operation.id}:cleanup`
        ).slice("sha256:".length)
      )
    });
    const beforePublished = journal;
    journal = replaceScaffoldJournalOperation(
      journal,
      operation.id,
      outcome === "applied" ? "published" : "preexisting"
    );
    journalAuthority = await replaceScaffoldJournalReconciled(
      continuation.journalStore,
      { journal: beforePublished, journalAuthority },
      journal
    );
    await continuation.faultInjector?.({
      phase: "after-journal-operation-published",
      operationIndex,
      operationPath: operation.path
    });
    receipts.set(operation.id, {
      operationId: operation.id,
      path: operation.path,
      outcome: continuation.recovered && outcome === "applied" ? "recovered" : outcome,
      resultDigest: operation.after.digest
    });
  }
  return { journal, journalAuthority, receipts };
}

async function continueJournal(
  options: AuthorityContinuationOptions
): Promise<AuthorityScaffoldReceipt> {
  const prepared = await prepareJournal(options);
  if (isReceipt(prepared)) {
    return prepared;
  }
  const published = await publishPendingOperations({
    continuation: options,
    journal: prepared.journal,
    journalAuthority: prepared.journalAuthority
  });
  if (isReceipt(published)) {
    return published;
  }
  return finalizeAuthorityScaffoldJournal({ ...options, ...published });
}

export async function applyAuthorityFilesystemScaffold(
  consumerRoot: string,
  plan: AuthorityScaffoldPlan
): Promise<AuthorityScaffoldReceipt> {
  return applyAuthorityFilesystemScaffoldWithFaultInjection(consumerRoot, plan);
}

/** Internal conformance seam. It is intentionally absent from package exports. */
export async function applyAuthorityFilesystemScaffoldWithFaultInjection(
  consumerRoot: string,
  callerPlan: AuthorityScaffoldPlan,
  faultInjector?: ScaffoldAuthorityFaultInjector
): Promise<AuthorityScaffoldReceipt> {
  const plan = snapshotAuthorityScaffoldPlan(callerPlan);
  await assertSchema("scaffold-plan/v1", plan, "scaffold-apply-plan");
  assertAuthorityScaffoldPlanDigest(plan);
  assertSafeOperationPaths(plan);
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const journalPath = join(
    canonicalRoot,
    LOCAL_STATE_DIRECTORY,
    SCAFFOLD_JOURNAL_FILE
  );
  const journalFaultContext: ScaffoldJournalFaultContext = {};
  const journalStore = new NodeScaffoldJournalStore(canonicalRoot, {
    faultInjector: async (point) => {
      if (point.phase === "after-candidate-synced") {
        await faultInjector?.({
          phase: "after-journal-temporary-synced",
          ...(journalFaultContext.operationIndex === undefined
            ? {}
            : { operationIndex: journalFaultContext.operationIndex }),
          ...(journalFaultContext.operationPath === undefined
            ? {}
            : { operationPath: journalFaultContext.operationPath })
        });
      }
      if (point.phase === "before-shared-quarantine" &&
        journalFaultContext.finalizing === true) {
        await faultInjector?.({ phase: "before-journal-quarantine" });
      }
    }
  });
  const lease = await acquireScaffoldingTransaction(canonicalRoot);
  try {
    const existing = await readScaffoldJournal(journalStore);
    if (existing !== undefined) {
      if (existing.journal.plan.planDigest !== plan.planDigest) {
        throw new ScaffoldError(
          "SCAFFOLD_RECOVERY_REQUIRED",
          "A different scaffolding transaction requires recovery before this Plan can apply."
        );
      }
      return await continueJournal({
        root: canonicalRoot,
        journalPath,
        journal: existing.journal,
        journalAuthority: existing.journalAuthority,
        journalStore,
        journalFaultContext,
        recovered: true,
        ...(faultInjector === undefined ? {} : { faultInjector })
      });
    }
    const authority = await assessScaffoldPlanAuthority(canonicalRoot, plan);
    if (authority.state === "stale") {
      return staleBeforeJournal(plan);
    }
    if (authority.state === "unverifiable") {
      return recoveryRequired(
        plan,
        "apply",
        "scaffolding.authority.unverifiable",
        "Authority cannot be re-verified safely; no transaction output was created.",
        "Restore readable authority sources, then compile a new Plan."
      );
    }
    let classifications;
    try {
      classifications = await safeClassifyPlan(canonicalRoot, plan);
      await assertTransactionTemporariesAbsent(canonicalRoot, plan);
    } catch {
      return recoveryRequired(
        plan,
        "apply",
        "scaffolding.apply.unverifiable-workspace",
        "The workspace cannot be safely prepared for this transaction.",
        "Resolve the filesystem state manually, then compile a new Plan."
      );
    }
    if (classifications.some(({ state }) => state === "conflict")) {
      let rejectedJournal = freshAuthorityScaffoldJournal(plan);
      for (const { operation, state } of classifications) {
        if (state === "after") {
          rejectedJournal = replaceScaffoldJournalOperation(
            rejectedJournal,
            operation.id,
            "preexisting"
          );
        }
      }
      return receiptFromJournalStates({
        plan,
        journal: rejectedJournal,
        outcome: "rejected",
        phase: "apply",
        conflictOperationIds: new Set(
          classifications
            .filter(({ state }) => state === "conflict")
            .map(({ operation }) => operation.id)
        )
      });
    }
    if (classifications.every(({ state }) => state === "after")) {
      return await verifyAlreadyAppliedScaffold({
        root: canonicalRoot,
        journalPath,
        journalStore,
        plan,
        ...(faultInjector === undefined ? {} : { faultInjector })
      });
    }
    let journal = freshAuthorityScaffoldJournal(plan);
    for (const { operation, state } of classifications) {
      if (state === "after") {
        journal = replaceScaffoldJournalOperation(journal, operation.id, "preexisting");
      }
    }
    const journalAuthority = await createScaffoldJournalReconciled(
      journalStore,
      journal
    );
    await faultInjector?.({ phase: "after-journal-prepared" });
    return await continueJournal({
      root: canonicalRoot,
      journalPath,
      journal,
      journalAuthority,
      journalStore,
      journalFaultContext,
      recovered: false,
      ...(faultInjector === undefined ? {} : { faultInjector })
    });
  } finally {
    await lease.release({
      retainTransactionBarrier: await scaffoldTransactionEvidenceExists(journalPath)
    });
  }
}

export async function recoverAuthorityFilesystemScaffold(
  consumerRoot: string
): Promise<AuthorityScaffoldReceipt | undefined> {
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const lease = await acquireScaffoldingTransaction(canonicalRoot);
  try {
    const journalPath = join(canonicalRoot, LOCAL_STATE_DIRECTORY, SCAFFOLD_JOURNAL_FILE);
    const journalStore = new NodeScaffoldJournalStore(canonicalRoot);
    const journalFaultContext: ScaffoldJournalFaultContext = {};
    const record = await readScaffoldJournal(journalStore);
    if (record === undefined) {
      return undefined;
    }
    assertSafeOperationPaths(record.journal.plan);
    return await continueJournal({
      root: canonicalRoot,
      journalPath,
      journal: record.journal,
      journalAuthority: record.journalAuthority,
      journalStore,
      journalFaultContext,
      recovered: true
    });
  } finally {
    await lease.release({
      retainTransactionBarrier: await scaffoldTransactionEvidenceExists(
        join(canonicalRoot, LOCAL_STATE_DIRECTORY, SCAFFOLD_JOURNAL_FILE)
      )
    });
  }
}

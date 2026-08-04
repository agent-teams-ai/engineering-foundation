import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AuthorityScaffoldJournal,
  AuthorityScaffoldOperationReceipt,
  AuthorityScaffoldPlan,
  AuthorityScaffoldReceipt
} from "../../contract/types.js";
import { assertAuthorityScaffoldPlanDigest } from "../../kernel/plan-validation.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import { acquireFoundationOperationLock } from "../../../local-mode/service.js";
import { LOCAL_STATE_DIRECTORY } from "../../../local-mode/types.js";
import { assessScaffoldPlanAuthority } from "./node-plan-authority.js";
import {
  assertSafeExistingAncestors,
  assertSafeOperationPaths
} from "./filesystem-path-guard.js";
import {
  assertTransactionTemporariesAbsent,
  publishFilesystemOperation
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
  recoveryRequiredForAuthority,
  resolveAuthority,
  safeClassifyPlan
} from "./filesystem-authority.js";
import {
  readScaffoldJournalEnvelope,
  reconcileAuthorityScaffoldJournalTemporary,
  SCAFFOLD_JOURNAL_FILE,
  writeAuthorityScaffoldJournal
} from "./filesystem-journal.js";

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
    | "before-final-authority-recheck"
    | "before-operation-authority-recheck";
  readonly operationIndex?: number;
  readonly operationPath?: string;
}

type ScaffoldAuthorityFaultInjector = (
  point: ScaffoldAuthorityFaultPoint
) => Promise<void> | void;

function journalFault(
  faultInjector: ScaffoldAuthorityFaultInjector | undefined,
  operationIndex?: number,
  operationPath?: string
): (() => Promise<void> | void) | undefined {
  return faultInjector === undefined
    ? undefined
    : () =>
        faultInjector({
          phase: "after-journal-temporary-synced",
          ...(operationIndex === undefined ? {} : { operationIndex }),
          ...(operationPath === undefined ? {} : { operationPath })
        });
}

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
  readonly recovered: boolean;
  readonly faultInjector?: ScaffoldAuthorityFaultInjector;
}

function isReceipt(value: unknown): value is AuthorityScaffoldReceipt {
  return typeof value === "object" && value !== null && "receiptDigest" in value;
}

async function prepareJournal(
  options: AuthorityContinuationOptions
): Promise<AuthorityScaffoldJournal | AuthorityScaffoldReceipt> {
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
      await writeAuthorityScaffoldJournal(
        options.journalPath,
        journal,
        journalFault(options.faultInjector)
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
  await writeAuthorityScaffoldJournal(
    options.journalPath,
    journal,
    journalFault(options.faultInjector)
  );
  return journal;
}

async function publishPendingOperations(options: {
  readonly continuation: AuthorityContinuationOptions;
  readonly journal: AuthorityScaffoldJournal;
}): Promise<
  | AuthorityScaffoldReceipt
  | {
      readonly journal: AuthorityScaffoldJournal;
      readonly receipts: ReadonlyMap<string, AuthorityScaffoldOperationReceipt>;
    }
> {
  const { continuation } = options;
  let journal = options.journal;
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
    journal = replaceScaffoldJournalOperation(journal, operation.id, "publishing");
    await writeAuthorityScaffoldJournal(
      continuation.journalPath,
      journal,
      journalFault(continuation.faultInjector, operationIndex, operation.path)
    );
    await continuation.faultInjector?.({
      phase: "after-journal-operation-publishing",
      operationIndex,
      operationPath: operation.path
    });
    const outcome = await publishFilesystemOperation(
      continuation.root,
      operation,
      journal.plan.planDigest,
      operationIndex,
      continuation.faultInjector
    );
    journal = replaceScaffoldJournalOperation(
      journal,
      operation.id,
      outcome === "applied" ? "published" : "preexisting"
    );
    await writeAuthorityScaffoldJournal(
      continuation.journalPath,
      journal,
      journalFault(continuation.faultInjector, operationIndex, operation.path)
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
  return { journal, receipts };
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
    journal: prepared
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
  plan: AuthorityScaffoldPlan,
  faultInjector?: ScaffoldAuthorityFaultInjector
): Promise<AuthorityScaffoldReceipt> {
  await assertSchema("scaffold-plan", plan, "scaffold-apply-plan");
  assertAuthorityScaffoldPlanDigest(plan);
  assertSafeOperationPaths(plan);
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const release = await acquireFoundationOperationLock(canonicalRoot);
  try {
    const journalPath = join(canonicalRoot, LOCAL_STATE_DIRECTORY, SCAFFOLD_JOURNAL_FILE);
    await reconcileAuthorityScaffoldJournalTemporary(journalPath);
    const existing = await readScaffoldJournalEnvelope(journalPath);
    if (existing !== undefined) {
      if (existing.plan.planDigest !== plan.planDigest) {
        throw new ScaffoldError(
          "SCAFFOLD_RECOVERY_REQUIRED",
          "A different scaffolding transaction requires recovery before this Plan can apply."
        );
      }
      return continueJournal({
        root: canonicalRoot,
        journalPath,
        journal: existing,
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
      return verifyAlreadyAppliedScaffold({
        root: canonicalRoot,
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
    await writeAuthorityScaffoldJournal(
      journalPath,
      journal,
      journalFault(faultInjector)
    );
    await faultInjector?.({ phase: "after-journal-prepared" });
    return continueJournal({
      root: canonicalRoot,
      journalPath,
      journal,
      recovered: false,
      ...(faultInjector === undefined ? {} : { faultInjector })
    });
  } finally {
    await release();
  }
}

export async function recoverAuthorityFilesystemScaffold(
  consumerRoot: string
): Promise<AuthorityScaffoldReceipt | undefined> {
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const release = await acquireFoundationOperationLock(canonicalRoot);
  try {
    const journalPath = join(canonicalRoot, LOCAL_STATE_DIRECTORY, SCAFFOLD_JOURNAL_FILE);
    await reconcileAuthorityScaffoldJournalTemporary(journalPath);
    const journal = await readScaffoldJournalEnvelope(journalPath);
    if (journal === undefined) {
      return undefined;
    }
    assertSafeOperationPaths(journal.plan);
    return continueJournal({
      root: canonicalRoot,
      journalPath,
      journal,
      recovered: true
    });
  } finally {
    await release();
  }
}

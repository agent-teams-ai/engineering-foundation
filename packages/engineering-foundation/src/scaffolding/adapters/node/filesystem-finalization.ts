import type {
  AuthorityScaffoldJournal,
  AuthorityScaffoldOperationReceipt,
  AuthorityScaffoldPlan,
  AuthorityScaffoldReceipt
} from "../../contract/types.js";
import { createAuthorityScaffoldReceipt } from "../../kernel/authority-receipt.js";
import {
  recoveryRequiredForAuthority,
  resolveAuthority,
  safeClassifyPlan
} from "./filesystem-authority.js";
import { assertNoOwnedCleanupResidue } from "./filesystem-operation-state.js";
import {
  createAuthorityDiagnostic,
  freshAuthorityScaffoldJournal,
  replaceScaffoldJournalOperation,
  receiptFromJournalStates
} from "./filesystem-journal-state.js";
import {
  captureExpectedAuthorityScaffoldJournal,
  removeExpectedAuthorityScaffoldJournal,
  writeAuthorityScaffoldJournal
} from "./filesystem-journal.js";
import { assessScaffoldPlanAuthority } from "./node-plan-authority.js";

interface FinalizationFaultPoint {
  readonly phase:
    | "after-final-verification"
    | "after-journal-unlinked"
    | "before-final-authority-recheck";
}

type FinalizationFaultInjector = (
  point: FinalizationFaultPoint
) => Promise<void> | void;

export function staleBeforeJournal(plan: AuthorityScaffoldPlan): AuthorityScaffoldReceipt {
  return createAuthorityScaffoldReceipt({
    plan,
    outcome: "authority-stale",
    commitState: "rolled-back",
    operations: plan.operations.map((operation) => ({
      operationId: operation.id,
      path: operation.path,
      outcome: "not-applied"
    })),
    diagnostics: [
      createAuthorityDiagnostic(
        "scaffolding.authority.stale",
        "apply",
        plan.projectId,
        "Consumer authority changed after planning.",
        "Compile a new Plan from the current consumer authority."
      )
    ]
  });
}

function authorityUnverifiableBeforeJournal(
  plan: AuthorityScaffoldPlan
): AuthorityScaffoldReceipt {
  return recoveryRequiredForAuthority({
    plan,
    phase: "apply",
    ruleId: "scaffolding.authority.unverifiable",
    message: "Authority cannot be re-verified safely; no output was created.",
    remediation: "Restore readable authority sources, then compile a new Plan."
  });
}

async function classifyBeforeJournal(options: {
  readonly root: string;
  readonly plan: AuthorityScaffoldPlan;
}): Promise<AuthorityScaffoldReceipt | Awaited<ReturnType<typeof safeClassifyPlan>>> {
  let states;
  try {
    await assertNoOwnedCleanupResidue(options.root, options.plan);
    states = await safeClassifyPlan(options.root, options.plan);
  } catch {
    return recoveryRequiredForAuthority({
      plan: options.plan,
      phase: "apply",
      ruleId: "scaffolding.apply.unverifiable-workspace",
      message: "The workspace cannot be safely verified before commit.",
      remediation: "Resolve the filesystem state manually, then compile a new Plan."
    });
  }
  if (states.every(({ state }) => state === "after")) {
    return states;
  }
  let journal = freshAuthorityScaffoldJournal(options.plan);
  for (const { operation, state } of states) {
    if (state === "after") {
      journal = replaceScaffoldJournalOperation(
        journal,
        operation.id,
        "preexisting"
      );
    }
  }
  return receiptFromJournalStates({
    plan: options.plan,
    journal,
    outcome: "rejected",
    phase: "apply",
    conflictOperationIds: new Set(
      states
        .filter(({ state }) => state === "conflict")
        .map(({ operation }) => operation.id)
    )
  });
}

export async function verifyAlreadyAppliedScaffold(options: {
  readonly root: string;
  readonly plan: AuthorityScaffoldPlan;
  readonly faultInjector?: FinalizationFaultInjector;
}): Promise<AuthorityScaffoldReceipt> {
  await options.faultInjector?.({ phase: "before-final-authority-recheck" });
  for (let pass = 0; pass < 2; pass += 1) {
    const authority = await assessScaffoldPlanAuthority(
      options.root,
      options.plan
    );
    if (authority.state === "stale") {
      return staleBeforeJournal(options.plan);
    }
    if (authority.state === "unverifiable") {
      return authorityUnverifiableBeforeJournal(options.plan);
    }
    const states = await classifyBeforeJournal(options);
    if (isReceipt(states)) {
      return states;
    }
  }
  await options.faultInjector?.({ phase: "after-final-verification" });
  return createAuthorityScaffoldReceipt({
    plan: options.plan,
    outcome: "already-applied",
    commitState: "committed",
    operations: options.plan.operations.map((operation) => ({
      operationId: operation.id,
      path: operation.path,
      outcome: "already-satisfied",
      resultDigest: operation.after.digest
    }))
  });
}

interface FinalizationOptions {
  readonly root: string;
  readonly journalPath: string;
  readonly journal: AuthorityScaffoldJournal;
  readonly recovered: boolean;
  readonly receipts: ReadonlyMap<string, AuthorityScaffoldOperationReceipt>;
  readonly faultInjector?: FinalizationFaultInjector;
}

function isReceipt(value: unknown): value is AuthorityScaffoldReceipt {
  return typeof value === "object" && value !== null && "receiptDigest" in value;
}

async function verifyOutputs(
  options: FinalizationOptions
): Promise<
  | AuthorityScaffoldReceipt
  | readonly {
      readonly operation: AuthorityScaffoldJournal["plan"]["operations"][number];
      readonly state: "absent" | "after" | "conflict";
    }[]
> {
  let states;
  try {
    await assertNoOwnedCleanupResidue(options.root, options.journal.plan);
    states = await safeClassifyPlan(options.root, options.journal.plan);
  } catch {
    return recoveryRequiredForAuthority({
      plan: options.journal.plan,
      phase: options.recovered ? "recovery" : "apply",
      ruleId: "scaffolding.recovery.unverifiable-workspace",
      message: "The workspace cannot be safely verified after publication.",
      remediation: "Resolve the filesystem state manually, then retry recovery."
    });
  }
  const conflictIds = new Set(
    states
      .filter(({ state }) => state !== "after")
      .map(({ operation }) => operation.id)
  );
  if (conflictIds.size === 0) {
    return states;
  }
  await writeAuthorityScaffoldJournal(options.journalPath, options.journal);
  return receiptFromJournalStates({
    plan: options.journal.plan,
    journal: options.journal,
    outcome: "recovery-required",
    phase: "recovery",
    conflictOperationIds: conflictIds
  });
}

function observedOperations(
  states: readonly {
    readonly operation: AuthorityScaffoldJournal["plan"]["operations"][number];
    readonly state: "absent" | "after" | "conflict";
  }[]
): readonly AuthorityScaffoldOperationReceipt[] {
  return states.map(({ operation }) => ({
    operationId: operation.id,
    path: operation.path,
    outcome: "already-satisfied" as const,
    resultDigest: operation.after.digest
  }));
}

export async function finalizeAuthorityScaffoldJournal(
  options: FinalizationOptions
): Promise<AuthorityScaffoldReceipt> {
  await options.faultInjector?.({ phase: "before-final-authority-recheck" });
  const firstAuthority = await resolveAuthority(options);
  if (firstAuthority !== undefined) {
    return firstAuthority;
  }
  const firstStates = await verifyOutputs(options);
  if (isReceipt(firstStates)) {
    return firstStates;
  }
  const finalAuthority = await resolveAuthority({
    ...options,
    observedOperations: observedOperations(firstStates)
  });
  if (finalAuthority !== undefined) {
    return finalAuthority;
  }
  const finalStates = await verifyOutputs(options);
  if (isReceipt(finalStates)) {
    return finalStates;
  }
  const journalIdentity = await captureExpectedAuthorityScaffoldJournal(
    options.journalPath,
    options.journal
  );
  await options.faultInjector?.({ phase: "after-final-verification" });
  await assertNoOwnedCleanupResidue(options.root, options.journal.plan);
  await removeExpectedAuthorityScaffoldJournal(
    options.journalPath,
    journalIdentity,
    options.faultInjector === undefined
      ? undefined
      : () => options.faultInjector?.({ phase: "after-journal-unlinked" })
  );
  return createAuthorityScaffoldReceipt({
    plan: options.journal.plan,
    outcome: options.recovered ? "failed-recovered" : "applied",
    commitState: options.recovered ? "recovered" : "committed",
    operations: options.journal.plan.operations.map((operation) =>
      options.receipts.get(operation.id) ?? {
        operationId: operation.id,
        path: operation.path,
        outcome: "already-satisfied" as const,
        resultDigest: operation.after.digest
      }
    )
  });
}
